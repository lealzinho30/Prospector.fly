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

  const domainPrefix = domain.split(".")[0]; // "cyrela"
  const companyGuess = domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1);

  async function fetchProxy(url, timeout = 10000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  // ── Get company name + email pattern from Hunter ───────────────────
  let orgName = null, pattern = null;
  try {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&domain=${encodeURIComponent(domain)}&limit=5`, { headers: { Accept: "application/json" } });
    const d = await r.json();
    orgName = d.data?.organization || null;
    pattern = d.data?.pattern || null;
  } catch(e) {}

  // Get company name from site if Hunter didn't return it
  if (!orgName) {
    const html = await fetchProxy(`https://${domain}`, 6000);
    const og = html.match(/og:site_name"[^>]*content="([^"]+)"/i) || html.match(/content="([^"]+)"[^>]*og:site_name/i);
    const title = html.match(/<title[^>]*>([^<|–\-]{3,40})/i);
    if (og) orgName = og[1].trim();
    else if (title) orgName = title[1].trim().split(/[-|–]/)[0].trim();
  }
  if (!orgName) orgName = companyGuess;

  // Short name = first meaningful word (e.g. "Cyrela" from "Cyrela Brazil Realty")
  const shortName = orgName.split(/\s+/)[0];

  let people = [], source = "";

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
            phone_numbers: [], organization: { name: orgName },
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
      if (d.data?.emails?.length) {
        people = d.data.emails.map(e => ({
          name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
          first_name: e.first_name, last_name: e.last_name,
          email: e.value, email_status: e.confidence >= 70 ? "verified" : "likely_to_engage",
          title: e.position, linkedin_url: e.linkedin || null,
          phone_numbers: [], organization: { name: orgName }, confidence: e.confidence,
        }));
        source = "hunter";
      }
    } catch(e) {}
  }

  // ── 4. LinkedIn via DuckDuckGo ─────────────────────────────────────
  // Uses BOTH full name AND short name to maximize hits
  const liPeople = [];
  const seenLinkedIn = new Set(people.map(p => (p.name||"").toLowerCase()));

  // Helper to infer email from a name
  function inferEmail(firstName, lastName) {
    const fn = (firstName||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
    const ln = (lastName||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
    if (!fn) return null;
    if (pattern) {
      return pattern.replace("{first}",fn).replace("{last}",ln).replace("{f}",fn[0]||"").replace("{l}",ln[0]||"") + "@" + domain;
    }
    return ln ? `${fn}.${ln}@${domain}` : `${fn}@${domain}`;
  }

  try {
    // Multiple queries: use short name (more likely to match LinkedIn titles)
    // LinkedIn titles typically say "at Cyrela" not "at Cyrela Brazil Realty"
    const queries = [
      `site:linkedin.com/in "${shortName}" Diretor OR Diretora OR Gerente marketing OR comercial`,
      `site:linkedin.com/in "${shortName}" CEO OR Presidente OR Fundador OR Head`,
      `site:linkedin.com/in "${orgName}" Diretor OR Gerente marketing`,
    ];

    for (const q of queries) {
      if (liPeople.length >= 8) break;
      const html = await fetchProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`, 10000);
      if (!html) continue;

      // Parse DuckDuckGo results
      // Format: <a class="result__a" href="...linkedin.com/in/slug...">Name - Title at Company | LinkedIn</a>
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]*linkedin\.com\/in\/([^"?/]+))[^"]*"[^>]*>([^<]+)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (liPeople.length >= 8) break;
        const rawUrl = m[1];
        const slug   = m[2];
        const rawText = m[3].trim();

        // Parse "João Silva - Diretor de Marketing at Cyrela | LinkedIn"
        const parts = rawText.split(/\s*[-–|]\s*/);
        const name = parts[0].trim();

        // Validate name: 2-4 words, no digits, no company-like content
        const words = name.split(/\s+/).filter(Boolean);
        if (words.length < 2 || words.length > 5) continue;
        if (/\d|@/.test(name)) continue;
        // Skip if slug looks like the company page
        if (slug === domainPrefix || slug.includes("company")) continue;
        // Skip if name IS the company
        if (name.toLowerCase() === shortName.toLowerCase()) continue;
        // Skip duplicates
        if (seenLinkedIn.has(name.toLowerCase())) continue;

        // Extract title - between first dash and "at Company"
        const titlePart = parts.slice(1).join(" ").replace(/\|.*$/,"").trim();
        const atIdx = titlePart.toLowerCase().lastIndexOf(" at ");
        const title = atIdx > 0 ? titlePart.slice(0, atIdx).trim() : titlePart.split("·")[0].trim();

        const cleanUrl = rawUrl.startsWith("http")
          ? rawUrl.split("?")[0]
          : `https://www.linkedin.com/in/${slug}`;

        const email = inferEmail(words[0], words[words.length-1]);
        seenLinkedIn.add(name.toLowerCase());

        liPeople.push({
          name, first_name: words[0], last_name: words[words.length-1],
          title: title.slice(0,80) || null,
          email,
          email_status: pattern ? "likely_to_engage" : "guessed",
          phone_numbers: [],
          organization: { name: orgName },
          linkedin_url: cleanUrl,
          is_linkedin: true,
        });
      }
    }
  } catch(e) {}

  const merged = [...people, ...liPeople].slice(0, 20);

  return res.status(200).json({
    source: merged.length ? (people.length ? source : "linkedin") : "none",
    people: merged, pattern, orgName,
    pagination: { total_entries: merged.length },
  });
}
