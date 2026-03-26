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

  const hunterKey  = "8f122be7c8440172a49875acc9356073cb141ce2";
  const snovId     = process.env.SNOV_CLIENT_ID;
  const snovSecret = process.env.SNOV_CLIENT_SECRET;
  const apolloKey  = process.env.APOLLO_API_KEY;

  const companyGuess = domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);

  async function fetchProxy(url, timeout = 9000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  let people = [], source = "", pattern = null, orgName = null;

  // ── 1. Snov.io ────────────────────────────────────────────────────
  if (snovId && snovSecret) {
    try {
      const tok = await fetch("https://api.snov.io/v1/oauth/access_token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: snovId, client_secret: snovSecret }),
      });
      const { access_token } = await tok.json();
      if (access_token) {
        const r = await fetch("https://api.snov.io/v2/get-domain-emails-with-info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token, domain, type: "all", limit: 30, lastId: 0 }),
        });
        const d = await r.json();
        if (d.emails?.length) {
          people = d.emails.map(e => ({
            name: [e.firstName, e.lastName].filter(Boolean).join(" ") || null,
            first_name: e.firstName, last_name: e.lastName, email: e.email,
            email_status: e.emailStatus === "valid" ? "verified" : "likely_to_engage",
            title: e.currentPosition?.position || null, linkedin_url: e.linkedInUrl || null,
            phone_numbers: [], organization: { name: e.currentPosition?.companyName || companyGuess },
          }));
          source = "snov";
        }
      }
    } catch(e) {}
  }

  // ── 2. Apollo.io ──────────────────────────────────────────────────
  if (apolloKey && !people.length) {
    try {
      const r = await fetch("https://api.apollo.io/v1/people/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey, "Cache-Control": "no-cache" },
        body: JSON.stringify({ page:1, per_page:25,
          person_seniorities: ["c_suite","vp","director","manager","senior","owner","founder"],
          q_organization_domains: domain }),
      });
      const d = await r.json();
      if (!d.error?.match(/free plan|upgrade/i) && d.people?.length) { people = d.people; source = "apollo"; }
    } catch(e) {}
  }

  // ── 3. Hunter.io ──────────────────────────────────────────────────
  if (!people.length) {
    try {
      const r = await fetch(`https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&domain=${encodeURIComponent(domain)}&limit=25`, { headers: { Accept: "application/json" } });
      const d = await r.json();
      pattern = d.data?.pattern || null;
      orgName = d.data?.organization || null;
      if (d.data?.emails?.length) {
        people = d.data.emails.map(e => ({
          name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
          first_name: e.first_name, last_name: e.last_name,
          email: e.value, email_status: e.confidence >= 70 ? "verified" : "likely_to_engage",
          title: e.position, linkedin_url: e.linkedin || null,
          phone_numbers: [], organization: { name: orgName || companyGuess }, confidence: e.confidence,
        }));
        source = "hunter";
      }
    } catch(e) {}
  }

  // ── 4. LinkedIn via DuckDuckGo — busca quem TRABALHA na empresa ───
  const empresa = orgName || companyGuess;
  const liPeople = [];

  try {
    // Queries corretas: busca "at [empresa]" no LinkedIn, não pelo nome como sobrenome
    const queries = [
      `site:linkedin.com/in "at ${empresa}" diretor OR diretora OR gerente marketing OR comercial`,
      `site:linkedin.com/in "at ${empresa}" CEO OR presidente OR fundador OR "head"`,
      `site:linkedin.com/in "${empresa}" "Diretor" OR "Gerente" OR "Head" cargo`,
    ];

    for (const q of queries) {
      const html = await fetchProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`, 8000);
      if (!html) continue;

      // Extract result links and titles — format: "Name - Title at Company | LinkedIn"
      const resultRe = /<a[^>]+class="result__a"[^>]*href="([^"]*linkedin\.com\/in\/[^"?]+)[^"]*"[^>]*>([^<]+)<\/a>/gi;
      const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([^<]{10,200})<\/a>/gi;

      const results = [], snippets = [];
      let m;
      while ((m = resultRe.exec(html)) !== null) results.push({ url: m[1], text: m[2].trim() });
      while ((m = snippetRe.exec(html)) !== null) snippets.push(m[1].replace(/<[^>]+>/g,"").trim());

      results.slice(0, 5).forEach((t, i) => {
        const fullText = t.text; // "João Silva - Diretor de Marketing at Cyrela | LinkedIn"
        
        // Extract name (before the dash or pipe)
        const namePart = fullText.split(/\s*[-–|]\s*/)[0].trim();
        
        // Extract title (between dashes)  
        const titleMatch = fullText.match(/[-–]\s*([^|]+?)\s*(?:at|na|em)\s+/i);
        const titleText = titleMatch ? titleMatch[1].trim() : (snippets[i] || "").split("·")[1]?.trim() || null;

        // Validate: name should look like a real name (2+ words, not the company name)
        const words = namePart.split(" ").filter(Boolean);
        const looksLikeName = words.length >= 2 && words.length <= 5;
        const isCompanyItself = namePart.toLowerCase().includes(empresa.toLowerCase().split(" ")[0].toLowerCase()) && words.length < 3;
        
        if (!namePart || !looksLikeName || isCompanyItself) return;
        
        // Skip if already in results
        const alreadyIn = people.some(p => (p.name||"").toLowerCase() === namePart.toLowerCase())
                       || liPeople.some(p => p.name.toLowerCase() === namePart.toLowerCase());
        if (alreadyIn) return;

        const linkedInUrl = t.url.startsWith("http") ? t.url : "https://www.linkedin.com/in/" + t.url.split("/in/")[1]?.split("?")[0];

        liPeople.push({
          name: namePart, first_name: words[0], last_name: words[words.length-1],
          title: titleText, email: null, email_status: "guessed",
          phone_numbers: [], organization: { name: empresa },
          linkedin_url: linkedInUrl, is_linkedin: true,
        });
      });
    }
  } catch(e) {}

  const merged = [...people, ...liPeople].slice(0, 20);

  return res.status(200).json({
    source: merged.length ? (people.length ? source : "linkedin") : "none",
    people: merged, pattern, orgName,
    pagination: { total_entries: merged.length },
  });
}
