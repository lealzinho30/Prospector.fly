export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  const { domain, seniority, department } = body;
  if (!domain) return res.status(400).json({ error: "Informe o domínio da empresa." });

  const HUNTER = "8f122be7c8440172a49875acc9356073cb141ce2";

  // ── ETAPA 1: Apollo.io (se tiver chave e plano pago) ─────────────
  const apolloKey = process.env.APOLLO_API_KEY;
  if (apolloKey) {
    try {
      const senMap = {
        executive: ["c_suite","owner","founder"],
        senior:    ["vp","director","manager","senior"],
        junior:    ["entry","junior","intern"],
        "":        ["c_suite","vp","director","manager","senior"],
      };
      const r = await fetch("https://api.apollo.io/v1/people/search", {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-Api-Key":apolloKey, "Cache-Control":"no-cache" },
        body: JSON.stringify({
          page:1, per_page:25,
          q_organization_domains: domain,
          person_seniorities: senMap[seniority||""],
          ...(department ? { person_departments:[department] } : {})
        }),
      });
      const d = await r.json();
      const isBlocked = d.error && /free plan|not accessible|upgrade|credits/i.test(d.error);
      if (!isBlocked && d.people && d.people.length > 0) {
        return res.status(200).json({ source:"apollo", ...d });
      }
    } catch(e) {}
  }

  // ── ETAPA 2: Hunter domain-search ────────────────────────────────
  let hunterPeople = [];
  let pattern = null;
  let organization = null;

  try {
    const params = new URLSearchParams({
      domain, api_key: HUNTER, limit: "20",
      ...(seniority==="executive" ? {seniority:"executive"} : {}),
      ...(seniority==="senior"    ? {seniority:"senior"}    : {}),
      ...(department ? {department} : {}),
    });
    const r = await fetch(`https://api.hunter.io/v2/domain-search?${params}`, { headers:{Accept:"application/json"} });
    const d = await r.json();
    pattern = d?.data?.pattern || null;
    organization = d?.data?.organization || null;
    const emails = d?.data?.emails || [];
    hunterPeople = emails.map(e => ({
      name: [e.first_name,e.last_name].filter(Boolean).join(" ")||null,
      first_name: e.first_name, last_name: e.last_name,
      email: e.value,
      email_status: e.confidence>=75?"verified":e.confidence>=45?"likely_to_engage":"guessed",
      title: e.position, linkedin_url: e.linkedin||null,
      phone_numbers: [], confidence: e.confidence,
      organization: { name: organization||domain },
    }));
  } catch(e) {}

  if (hunterPeople.length > 0) {
    return res.status(200).json({ source:"hunter", people:hunterPeople, pattern, pagination:{total_entries:hunterPeople.length} });
  }

  // ── ETAPA 3: Busca nomes via web scraping + Hunter email-finder ──
  // Scrapa LinkedIn/Google para achar nomes de decisores, depois usa Hunter
  // email-finder para cada um
  let people = [];

  try {
    // Scrapa página de busca do LinkedIn via allorigins
    const companyName = organization || domain.split(".")[0];
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(companyName+" director OR gerente OR diretor OR CEO")}&origin=GLOBAL_SEARCH_HEADER`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(searchUrl)}`;

    const proxyRes = await fetch(proxyUrl, { headers:{Accept:"application/json"} });
    const proxyData = await proxyRes.json();
    const html = proxyData.contents || "";

    // Extrai nomes do HTML do LinkedIn
    const nameRegex = /aria-label="([A-ZÀ-Ú][a-záéíóúàèìòùâêîôûãõ]+ [A-ZÀ-Ú][a-záéíóúàèìòùâêîôûãõ]+)/g;
    const names = new Set();
    let m;
    while ((m = nameRegex.exec(html)) !== null) {
      if (names.size >= 8) break;
      names.add(m[1]);
    }

    // Para cada nome encontrado, usa Hunter email-finder
    for (const fullName of names) {
      const parts = fullName.trim().split(" ");
      const fn = parts[0];
      const ln = parts[parts.length-1];
      try {
        const r = await fetch(
          `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(fn)}&last_name=${encodeURIComponent(ln)}&api_key=${HUNTER}`,
          { headers:{Accept:"application/json"} }
        );
        const d = await r.json();
        if (d.data?.email) {
          people.push({
            name: fullName,
            first_name: fn, last_name: ln,
            email: d.data.email,
            email_status: d.data.score>=75?"verified":"likely_to_engage",
            title: d.data.position||null,
            linkedin_url: null,
            phone_numbers: [],
            organization: { name: organization||domain },
            confidence: d.data.score||50,
          });
        }
      } catch(e) {}
    }
  } catch(e) {}

  if (people.length > 0) {
    return res.status(200).json({ source:"hunter_finder", people, pattern, pagination:{total_entries:people.length} });
  }

  // ── ETAPA 4: Padrão inferido + nomes do CNPJ/web ─────────────────
  // Se nada funcionou, retorna pattern para o frontend usar com sócios
  return res.status(200).json({
    source:"pattern_only",
    people:[],
    pattern,
    organization,
    message: pattern
      ? `Padrão de email encontrado: ${pattern}@${domain}. Use a aba CNPJ + Sócios para gerar emails dos decisores com este padrão.`
      : `Nenhum contato encontrado para ${domain}. Tente a aba CNPJ + Sócios para buscar via Receita Federal.`,
    pagination:{total_entries:0}
  });
}
