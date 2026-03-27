export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  const { domain } = body;
  if (!domain) return res.status(400).json({ error: "Informe o domínio." });

  const hunterKey = "8f122be7c8440172a49875acc9356073cb141ce2";
  const domainPrefix = domain.split(".")[0];

  function extractCNPJ(text) {
    const m = (text||"").match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/g) || [];
    for (const c of m) { const d = c.replace(/\D/g,""); if (d.length===14) return d; }
    return null;
  }

  async function fetchProxy(url, timeout=8000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers:{Accept:"application/json"}, signal:AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  try {
    // ── 1. Identify company name from Hunter + site ──────────────────
    let orgName = null, pattern = null, cnpjFromSite = null;

    try {
      const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`, {headers:{Accept:"application/json"}});
      const d = await r.json();
      orgName = d.data?.organization || null;
      pattern = d.data?.pattern || null;
    } catch(e) {}

    const siteHtml = await fetchProxy(`https://${domain}`);
    if (siteHtml) {
      cnpjFromSite = extractCNPJ(siteHtml);
      if (!orgName) {
        const og = siteHtml.match(/og:site_name"[^>]*content="([^"]+)"/i) || siteHtml.match(/content="([^"]+)"[^>]*og:site_name/i);
        const titleM = siteHtml.match(/<title[^>]*>([^<|–\-]{3,50})/i);
        if (og) orgName = og[1].trim();
        else if (titleM) orgName = titleM[1].trim().split(/[-|–]/)[0].trim();
      }
    }

    if (!orgName) orgName = domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1);

    // Short name = first word (e.g. "Cyrela" from "Cyrela Brazil Realty")
    const shortName = orgName.split(/\s+/)[0];

    // ── 2. Find CNPJ — multiple strategies ───────────────────────────
    let cnpjNum = cnpjFromSite;

    // DuckDuckGo search with multiple name variations
    if (!cnpjNum) {
      // Generate multiple name variations for CNPJ search
    const nameVariations = [...new Set([
      shortName,
      orgName,
      orgName.replace(/&/g," e ").replace(/\s+/g," ").trim(),  // "Plano&Plano" → "Plano e Plano"
      domainPrefix.replace(/e([a-z])/g,"e $1").replace(/([a-z])e([a-z])/g,"$1 e $2"), // "planoeplano" → "plano e plano"
      domainPrefix,
    ])];
    const searchTerms = nameVariations.flatMap(n => [
      `"${n}" CNPJ`,
      `${n} CNPJ incorporadora`,
    ]).slice(0, 6);
      for (const q of searchTerms) {
        if (cnpjNum) break;
        // DuckDuckGo instant answer
        try {
          const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`, {headers:{Accept:"application/json"}, signal:AbortSignal.timeout(7000)});
          const d = await r.json();
          const text = [d.AbstractText, ...(d.RelatedTopics||[]).map(t=>t.Text||"")].join(" ");
          cnpjNum = extractCNPJ(text);
        } catch(e) {}

        // DuckDuckGo HTML results
        if (!cnpjNum) {
          const html = await fetchProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`, 8000);
          cnpjNum = extractCNPJ(html);
        }
      }
    }

    // cnpj.biz with multiple name variations
    if (!cnpjNum) {
      for (const q of [shortName, orgName, domainPrefix]) {
        if (cnpjNum) break;
        const html = await fetchProxy(`https://cnpj.biz/procura/${encodeURIComponent(q)}`, 7000);
        cnpjNum = extractCNPJ(html);
      }
    }

    // BrasilAPI search — try multiple name forms
    if (!cnpjNum) {
      const brazilQueries = [...new Set([
        shortName,
        orgName.replace(/&/g,"e").replace(/\s+/g," ").trim(),
        domainPrefix.replace(/([a-z])e([a-z])/g,"$1 $2"), // "planoeplano" → "plano plano"
        orgName.split(" ").slice(0,3).join(" "),
      ])];
      for (const q of brazilQueries) {
        if (cnpjNum) break;
        try {
          const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(q)}&page=1&perPage=5`, {headers:{Accept:"application/json"}});
          if (r.ok) {
            const list = await r.json();
            const items = Array.isArray(list) ? list : [];
            const sn = shortName.toLowerCase();
            const best = items.find(i => (i.nome_fantasia||"").toLowerCase().includes(sn))
                      || items.find(i => (i.razao_social||"").toLowerCase().includes(sn))
                      || items[0];
            if (best) cnpjNum = (best.cnpj||"").replace(/\D/g,"");
          }
        } catch(e) {}
      }
    }

    // ── 3. Receita Federal ───────────────────────────────────────────
    let cnpjData = null;
    if (cnpjNum) {
      try {
        const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, {headers:{Accept:"application/json"}});
        if (r.ok) cnpjData = await r.json();
      } catch(e) {}
    }

    const qsa = cnpjData?.qsa || [];
    const empresa = cnpjData?.nome_fantasia || cnpjData?.razao_social || orgName;
    const cnpjFmt = cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null;

    if (!cnpjNum) {
      return res.status(200).json({source:"socios", people:[], empresa:orgName, cnpj:null, needs_manual:true,
        warning:`Empresa: "${orgName}" — CNPJ não localizado automaticamente. Cole o CNPJ abaixo.`});
    }
    if (!qsa.length) {
      return res.status(200).json({source:"socios", people:[], empresa, cnpj:cnpjFmt,
        warning:"CNPJ encontrado, sem sócios registrados."});
    }

    // ── 4. Build contacts with email inference ───────────────────────
    const people = qsa.map(s => {
      const full = (s.nome_socio||s.nome||"").trim();
      const parts = full.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").split(" ").filter(Boolean);
      const fn = parts[0]||"", ln = parts[parts.length-1]||"";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio / Administrador";

      let email = null;
      if (fn) {
        email = pattern
          ? pattern.replace("{first}",fn).replace("{last}",ln).replace("{f}",fn[0]||"").replace("{l}",ln[0]||"")+"@"+domain
          : `${fn}.${ln}@${domain}`;
      }

      return {
        name: full, first_name: fn, last_name: ln, title: qual,
        email, email_status: pattern ? "likely_to_engage" : "guessed",
        email_alternatives: fn && ln ? [
          `${fn}@${domain}`,
          `${fn[0]}${ln}@${domain}`,
        ] : [],
        phone_numbers: [],
        organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(full+" "+shortName)}`,
        is_socio: true,
      };
    });

    return res.status(200).json({
      source:"socios", people, empresa,
      razao_social: cnpjData?.razao_social, cnpj: cnpjFmt, pattern,
      pagination: { total_entries: people.length },
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
