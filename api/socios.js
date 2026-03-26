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

  function extractCNPJ(text) {
    const m = (text || "").match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/g) || [];
    for (const c of m) { const d = c.replace(/\D/g,""); if (d.length === 14) return d; }
    return null;
  }

  async function fetchProxy(url, timeout = 7000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  async function fetchDirect(url, timeout = 6000) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeout) });
      if (r.ok) return await r.json();
    } catch(e) {}
    return null;
  }

  try {
    // ── 1. Identifica empresa e padrão de email ─────────────────────
    let empresaNome = null, pattern = null, cnpjFromSite = null;

    try {
      const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`, { headers: { Accept: "application/json" } });
      const d = await r.json();
      empresaNome = d.data?.organization || null;
      pattern = d.data?.pattern || null;
    } catch(e) {}

    // Read site for CNPJ and company name
    const siteHtml = await fetchProxy(`https://${domain}`);
    if (siteHtml) {
      cnpjFromSite = extractCNPJ(siteHtml);
      if (!empresaNome) {
        const og = siteHtml.match(/og:site_name"[^>]*content="([^"]+)"/i) || siteHtml.match(/content="([^"]+)"[^>]*og:site_name/i);
        const title = siteHtml.match(/<title[^>]*>([^<|–\-]{3,50})/i);
        if (og) empresaNome = og[1].trim();
        else if (title) empresaNome = title[1].trim().split(/[-|–]/)[0].trim();
      }
    }

    if (!empresaNome) {
      empresaNome = domain.split(".")[0].replace(/[^a-zA-Z0-9]/g," ").trim();
      empresaNome = empresaNome.charAt(0).toUpperCase() + empresaNome.slice(1);
    }

    // ── 2. Busca CNPJ em múltiplas fontes ────────────────────────────
    let cnpjNum = cnpjFromSite;

    // BrasilAPI search with multiple queries
    if (!cnpjNum) {
      const queries = [
        empresaNome,
        empresaNome.split(" ")[0], // first word only
        domain.split(".")[0],      // domain prefix
      ];
      for (const q of queries) {
        if (cnpjNum) break;
        try {
          const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(q)}&page=1&perPage=5`, { headers: { Accept: "application/json" } });
          if (r.ok) {
            const list = await r.json();
            const items = Array.isArray(list) ? list : (list.data || []);
            // Find best match - prefer nome fantasia containing the query
            const best = items.find(i => (i.nome_fantasia||"").toLowerCase().includes(q.toLowerCase().split(" ")[0])) || items[0];
            if (best) cnpjNum = (best.cnpj || "").replace(/\D/g,"");
          }
        } catch(e) {}
      }
    }

    // cnpj.biz scrape
    if (!cnpjNum) {
      const biz = await fetchProxy(`https://cnpj.biz/procura/${encodeURIComponent(empresaNome)}`);
      if (biz) cnpjNum = extractCNPJ(biz);
    }

    // ── 3. Receita Federal ───────────────────────────────────────────
    let cnpjData = null;
    if (cnpjNum) {
      cnpjData = await fetchDirect(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`);
      if (!cnpjData) {
        // Try receitaws fallback
        cnpjData = await fetchDirect(`https://receitaws.com.br/v1/cnpj/${cnpjNum}`);
      }
    }

    const qsa = cnpjData?.qsa || [];
    const empresa = cnpjData?.nome_fantasia || cnpjData?.razao_social || cnpjData?.company || empresaNome;
    const cnpjFmt = cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null;

    if (!cnpjNum) {
      return res.status(200).json({ source:"socios", people:[], empresa:empresaNome, cnpj:null, needs_manual:true,
        warning:`Empresa identificada como "${empresaNome}" — CNPJ não localizado automaticamente.` });
    }

    if (!qsa.length) {
      return res.status(200).json({ source:"socios", people:[], empresa, cnpj:cnpjFmt,
        warning:"CNPJ encontrado mas sem quadro societário registrado." });
    }

    // ── 4. Monta contatos dos sócios / administradores ───────────────
    const people = qsa.map(s => {
      const full = (s.nome_socio || s.nome || "").trim();
      const parts = full.toLowerCase().split(" ").filter(Boolean);
      const fn = parts[0] || "", ln = parts[parts.length-1] || "";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio / Administrador";

      // Email inference with 3 common BR patterns
      const emailPatterns = pattern
        ? [pattern.replace("{first}",fn).replace("{last}",ln).replace("{f}",fn[0]||"").replace("{l}",ln[0]||"")+"@"+domain]
        : [`${fn}.${ln}@${domain}`, `${fn}@${domain}`, `${fn[0]||""}${ln}@${domain}`];

      return {
        name: full, first_name: fn, last_name: ln, title: qual,
        email: emailPatterns[0],
        email_status: pattern ? "likely_to_engage" : "guessed",
        email_alternatives: emailPatterns.slice(1),
        phone_numbers: [],
        organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(full+" "+empresa)}`,
        is_socio: true,
      };
    });

    return res.status(200).json({ source:"socios", people, empresa, razao_social:cnpjData?.razao_social, cnpj:cnpjFmt, pattern, pagination:{ total_entries:people.length } });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
