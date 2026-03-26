export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch(e) { body = {}; }
  }
  body = body || {};

  const apolloKey = process.env.APOLLO_API_KEY;
  const hunterKey = "8f122be7c8440172a49875acc9356073cb141ce2";
  const { company, domain, seniority, department } = body;

  if (!company && !domain) {
    return res.status(400).json({ error: "Preencha empresa ou domínio para buscar." });
  }

  const senMap = {
    executive: ["c_suite","owner","founder"],
    senior:    ["vp","director","manager","senior"],
    junior:    ["entry","junior","intern"],
    "":        ["c_suite","vp","director","manager","senior"],
  };

  // ── Apollo ──────────────────────────────────────────────────────────
  if (apolloKey) {
    try {
      const payload = {
        page: 1, per_page: 25,
        person_seniorities: senMap[seniority||""],
      };
      if (domain)     payload.q_organization_domains = domain;
      if (company)    payload.q_keywords = company;
      if (department) payload.person_departments = [department];

      const r = await fetch("https://api.apollo.io/v1/people/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey, "Cache-Control": "no-cache" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      const isLimited = d.error && /free plan|not accessible|upgrade|credits/i.test(d.error);
      if (!isLimited && d.people && d.people.length > 0) {
        return res.status(200).json({ source: "apollo", ...d });
      }
    } catch(e) {}
  }

  // ── Hunter.io fallback ──────────────────────────────────────────────
  try {
    let url = `https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&limit=20`;
    if (domain)           url += `&domain=${encodeURIComponent(domain)}`;
    else if (company)     url += `&company=${encodeURIComponent(company)}`;
    if (department)       url += `&department=${encodeURIComponent(department)}`;
    if (seniority==="executive") url += "&seniority=executive";
    else if (seniority==="senior") url += "&seniority=senior";

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const d = await r.json();

    // Hunter retorna 'errors' mesmo com dados — só falha se não tiver emails
    const hasData = d.data?.emails && d.data.emails.length > 0;
    if (d.errors && !hasData) return res.status(400).json({ error: d.errors[0]?.details || "Nenhum contato encontrado." });

    const people = (d.data?.emails || []).map(e => ({
      name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
      first_name: e.first_name, last_name: e.last_name,
      email: e.value,
      email_status: e.confidence >= 75 ? "verified" : e.confidence >= 45 ? "likely_to_engage" : "guessed",
      title: e.position, linkedin_url: e.linkedin || null,
      phone_numbers: [], organization: { name: company || domain }, confidence: e.confidence,
    }));

    return res.status(200).json({ source: "hunter", people, pattern: d.data?.pattern, pagination: { total_entries: people.length } });
  } catch(e) {
    return res.status(500).json({ error: "Falha na busca: " + e.message });
  }
}
