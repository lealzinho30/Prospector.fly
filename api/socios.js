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

  async function fetchProxy(url, timeout = 8000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  // DuckDuckGo search — free, no API key, no blocks
  async function ddgSearch(query) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      // Combine all text from results
      const texts = [d.AbstractText || ""];
      (d.RelatedTopics || []).forEach(t => { if (t.Text) texts.push(t.Text); });
      (d.Results || []).forEach(t => { if (t.Text) texts.push(t.Text); if (t.FirstURL) texts.push(t.FirstURL); });
      return texts.join(" ");
    } catch(e) { return ""; }
  }

  // DuckDuckGo HTML search (returns web results)
  async function ddgWeb(query) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const html = await fetchProxy(url, 8000);
      return html;
    } catch(e) { return ""; }
  }

  try {
    // ── 1. Identifica empresa via Hunter e site ──────────────────────
    let empresaNome = null, pattern = null, cnpjFromSite = null;

    try {
      const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`, { headers: { Accept: "application/json" } });
      const d = await r.json();
      empresaNome = d.data?.organization || null;
      pattern = d.data?.pattern || null;
    } catch(e) {}

    const siteHtml = await fetchProxy(`https://${domain}`);
    if (siteHtml) {
      cnpjFromSite = extractCNPJ(siteHtml);
      if (!empresaNome) {
        const og = siteHtml.match(/og:site_name"[^>]*content="([^"]+)"/i) || siteHtml.match(/content="([^"]+)"[^>]*og:site_name/i);
        const titleMatch = siteHtml.match(/<title[^>]*>([^<|–\-]{3,50})/i);
        if (og) empresaNome = og[1].trim();
        else if (titleMatch) empresaNome = titleMatch[1].trim().split(/[-|–]/)[0].trim();
      }
    }

    if (!empresaNome) {
      empresaNome = domain.split(".")[0].replace(/[^a-zA-Z0-9\s]/g," ").trim();
      empresaNome = empresaNome.charAt(0).toUpperCase() + empresaNome.slice(1);
    }

    // ── 2. Busca CNPJ no Google/DuckDuckGo ──────────────────────────
    let cnpjNum = cnpjFromSite;

    if (!cnpjNum) {
      // Search DuckDuckGo for CNPJ
      const searches = [
        `${empresaNome} CNPJ`,
        `${domain} CNPJ`,
        `"${empresaNome}" CNPJ receita federal`,
      ];

      for (const q of searches) {
        if (cnpjNum) break;
        // Try DDG instant answer
        const ddgText = await ddgSearch(q);
        cnpjNum = extractCNPJ(ddgText);

        // Try DDG web results
        if (!cnpjNum) {
          const ddgHtml = await ddgWeb(q);
          cnpjNum = extractCNPJ(ddgHtml);
        }

        // Try cnpj.biz directly
        if (!cnpjNum) {
          const bizHtml = await fetchProxy(`https://cnpj.biz/procura/${encodeURIComponent(empresaNome)}`);
          cnpjNum = extractCNPJ(bizHtml);
        }
      }
    }

    // BrasilAPI search fallback
    if (!cnpjNum) {
      const queries = [empresaNome, empresaNome.split(" ")[0], domain.split(".")[0]];
      for (const q of queries) {
        if (cnpjNum) break;
        try {
          const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(q)}&page=1&perPage=5`, { headers: { Accept: "application/json" } });
          if (r.ok) {
            const list = await r.json();
            const items = Array.isArray(list) ? list : [];
            const best = items.find(i => (i.nome_fantasia||"").toLowerCase().includes(q.toLowerCase().split(" ")[0]))
                      || items.find(i => (i.razao_social||"").toLowerCase().includes(q.toLowerCase().split(" ")[0]))
                      || items[0];
            if (best) cnpjNum = (best.cnpj || "").replace(/\D/g,"");
          }
        } catch(e) {}
      }
    }

    // ── 3. Busca QSA na Receita Federal ─────────────────────────────
    let cnpjData = null;
    if (cnpjNum) {
      try {
        const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, { headers: { Accept: "application/json" } });
        if (r.ok) cnpjData = await r.json();
      } catch(e) {}
    }

    const qsa = cnpjData?.qsa || [];
    const empresa = cnpjData?.nome_fantasia || cnpjData?.razao_social || empresaNome;
    const cnpjFmt = cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null;

    // ── 4. Busca perfis no LinkedIn via DuckDuckGo ───────────────────
    let linkedinProfiles = [];
    try {
      const liQuery = `site:linkedin.com/in "${empresaNome}" diretor OR gerente OR marketing OR comercial`;
      const liHtml = await ddgWeb(liQuery);
      if (liHtml) {
        // Extract LinkedIn URLs and names from results
        const linkMatches = liHtml.match(/linkedin\.com\/in\/[a-z0-9\-]+/gi) || [];
        const snippets = liHtml.match(/<a[^>]*class="result__a"[^>]*>([^<]{5,80})<\/a>/gi) || [];
        const descs = liHtml.match(/<a[^>]*class="result__snippet"[^>]*>([^<]{10,150})<\/a>/gi) || [];

        const seen = new Set();
        snippets.slice(0, 6).forEach((s, i) => {
          const name = s.replace(/<[^>]+>/g,"").trim();
          const desc = (descs[i] || "").replace(/<[^>]+>/g,"").trim();
          const linkedInUrl = linkMatches[i] ? "https://www." + linkMatches[i] : null;
          if (!name || seen.has(name)) return;
          // Parse "Name - Title at Company" or just name
          const parts = desc.split(/\s*[-–·]\s*/);
          const title = parts.find(p => /diretor|gerente|marketing|comercial|ceo|cmo|head|manager|director/i.test(p)) || parts[1] || null;
          seen.add(name);
          linkedinProfiles.push({ name, title: title?.trim() || null, linkedin_url: linkedInUrl, source: "linkedin" });
        });
      }
    } catch(e) {}

    if (!cnpjNum && !linkedinProfiles.length) {
      return res.status(200).json({ source:"socios", people:[], empresa:empresaNome, cnpj:null, needs_manual:true,
        warning:`Empresa identificada como "${empresaNome}" — cole o CNPJ abaixo para buscar o quadro societário.` });
    }

    // ── 5. Monta lista final: QSA + LinkedIn ─────────────────────────
    const peopleFromQSA = qsa.map(s => {
      const full = (s.nome_socio || s.nome || "").trim();
      const parts = full.toLowerCase().split(" ").filter(Boolean);
      const fn = parts[0] || "", ln = parts[parts.length-1] || "";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio / Administrador";
      const emailPatterns = pattern
        ? [pattern.replace("{first}",fn).replace("{last}",ln).replace("{f}",fn[0]||"").replace("{l}",ln[0]||"")+"@"+domain]
        : [`${fn}.${ln}@${domain}`, `${fn}@${domain}`, `${fn[0]||""}${ln}@${domain}`];
      return {
        name: full, first_name: fn, last_name: ln, title: qual,
        email: emailPatterns[0], email_status: pattern ? "likely_to_engage" : "guessed",
        email_alternatives: emailPatterns.slice(1), phone_numbers: [],
        organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(full+" "+empresa)}`,
        is_socio: true,
      };
    });

    const peopleFromLinkedIn = linkedinProfiles.map(p => ({
      name: p.name, first_name: (p.name||"").split(" ")[0], last_name: (p.name||"").split(" ").pop(),
      title: p.title, email: null, email_status: "guessed",
      phone_numbers: [], organization: { name: empresa },
      linkedin_url: p.linkedin_url, is_linkedin: true,
    }));

    const allPeople = [...peopleFromQSA, ...peopleFromLinkedIn.filter(l => !peopleFromQSA.find(q => q.name.toLowerCase() === l.name.toLowerCase()))];

    return res.status(200).json({
      source: "socios", people: allPeople, empresa,
      razao_social: cnpjData?.razao_social, cnpj: cnpjFmt, pattern,
      pagination: { total_entries: allPeople.length },
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
