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

  const HUNTER     = "8f122be7c8440172a49875acc9356073cb141ce2";
  const SNOV_ID    = process.env.SNOV_CLIENT_ID;
  const SNOV_SEC   = process.env.SNOV_CLIENT_SECRET;
  const APOLLO_KEY = process.env.APOLLO_API_KEY;

  const domainPrefix = domain.split(".")[0];

  async function fetchProxy(url, timeout = 9000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  // ── Step 0: Get org name + email pattern from Hunter ──────────────
  let orgName = null, pattern = null;
  try {
    const r = await fetch(
      `https://api.hunter.io/v2/domain-search?api_key=${HUNTER}&domain=${encodeURIComponent(domain)}&limit=10`,
      { headers: { Accept: "application/json" } }
    );
    const d = await r.json();
    orgName = d.data?.organization || null;
    pattern = d.data?.pattern || null;

    // If Hunter returns emails directly — use them
    if (d.data?.emails?.length) {
      const people = d.data.emails.map(e => ({
        name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
        first_name: e.first_name, last_name: e.last_name,
        email: e.value, email_status: e.confidence >= 70 ? "verified" : "likely_to_engage",
        title: e.position, linkedin_url: e.linkedin || null,
        phone_numbers: [], organization: { name: orgName || domain }, confidence: e.confidence,
      }));
      // Still add LinkedIn contacts on top
      const liPeople = await searchLinkedIn(domain, orgName || domainPrefix, pattern, people);
      return res.status(200).json({
        source: "hunter", people: [...people, ...liPeople].slice(0, 20),
        pattern, orgName, pagination: { total_entries: people.length + liPeople.length }
      });
    }
  } catch(e) {}

  if (!orgName) {
    const html = await fetchProxy(`https://${domain}`, 6000);
    const og = html.match(/og:site_name"[^>]*content="([^"]+)"/i) || html.match(/content="([^"]+)"[^>]*og:site_name/i);
    const title = html.match(/<title[^>]*>([^<|–\-]{3,40})/i);
    if (og) orgName = og[1].trim();
    else if (title) orgName = title[1].trim().split(/[-|–]/)[0].trim();
    else orgName = domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1);
  }

  const shortName = orgName.split(/\s+/)[0];
  let people = [], source = "";

  // ── 1. Snov.io — verified emails ──────────────────────────────────
  if (SNOV_ID && SNOV_SEC) {
    try {
      const tok = await fetch("https://api.snov.io/v1/oauth/access_token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: SNOV_ID, client_secret: SNOV_SEC }),
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

  // ── 2. Apollo — FREE endpoint that WORKS: mixed_people/api_search ─
  // This endpoint is free, no credits consumed, returns names + LinkedIn
  // Then we infer emails using Hunter pattern
  if (APOLLO_KEY) {
    try {
      const url = `https://api.apollo.io/api/v1/mixed_people/api_search?` +
        `q_organization_domains[]=${encodeURIComponent(domain)}` +
        `&person_seniorities[]=c_suite&person_seniorities[]=vp&person_seniorities[]=director&person_seniorities[]=manager&person_seniorities[]=senior` +
        `&page=1&per_page=25`;

      const r = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY, "Cache-Control": "no-cache" },
      });
      const d = await r.json();

      if (d.people?.length) {
        const apolloPeople = d.people.map(p => {
          const fn = (p.first_name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
          const ln = (p.last_name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
          const email = inferEmail(fn, ln, pattern, domain);
          return {
            name: [p.first_name, p.last_name].filter(Boolean).join(" "),
            first_name: p.first_name, last_name: p.last_name,
            email, email_status: pattern ? "likely_to_engage" : "guessed",
            title: p.title, linkedin_url: p.linkedin_url || null,
            phone_numbers: p.phone_numbers || [],
            organization: { name: p.organization?.name || orgName },
          };
        });

        // Merge with Snov (avoid duplicates)
        const seen = new Set(people.map(p => (p.name||"").toLowerCase()));
        apolloPeople.forEach(p => { if (!seen.has((p.name||"").toLowerCase())) { seen.add((p.name||"").toLowerCase()); people.push(p); } });
        if (!source) source = "apollo";
      }
    } catch(e) {}
  }

  // ── 3. LinkedIn via DuckDuckGo — always runs ──────────────────────
  const liPeople = await searchLinkedIn(domain, shortName, pattern, people);
  const merged = [...people, ...liPeople].slice(0, 20);

  return res.status(200).json({
    source: merged.length ? (people.length ? source : "linkedin") : "none",
    people: merged, pattern, orgName,
    pagination: { total_entries: merged.length },
  });

  // ── Helpers ───────────────────────────────────────────────────────
  function inferEmail(fn, ln, pat, dom) {
    if (!fn) return null;
    if (pat) return pat.replace("{first}",fn).replace("{last}",ln||"").replace("{f}",fn[0]||"").replace("{l}",(ln||"")[0]||"") + "@" + dom;
    return ln ? `${fn}.${ln}@${dom}` : `${fn}@${dom}`;
  }

  async function searchLinkedIn(domain, name, pat, existing) {
    const seenNames = new Set(existing.map(p => (p.name||"").toLowerCase()));
    const found = [];
    const queries = [
      `site:linkedin.com/in "${name}" Diretor OR Diretora OR Gerente marketing OR comercial`,
      `site:linkedin.com/in "${name}" CEO OR Presidente OR Fundador OR Head`,
    ];
    for (const q of queries) {
      if (found.length >= 8) break;
      const html = await fetchProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`, 10000);
      if (!html) continue;
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]*linkedin\.com\/in\/([^"?/]+))[^"]*"[^>]*>([^<]+)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (found.length >= 8) break;
        const url = m[1].startsWith("http") ? m[1].split("?")[0] : `https://www.linkedin.com/in/${m[2]}`;
        const raw = m[3].trim();
        const parts = raw.split(/\s*[-–|]\s*/);
        const pname = parts[0].trim();
        const words = pname.split(/\s+/).filter(Boolean);
        if (words.length < 2 || words.length > 5 || /\d/.test(pname)) continue;
        if (m[2] === domain.split(".")[0]) continue;
        if (seenNames.has(pname.toLowerCase())) continue;
        const titlePart = parts.slice(1).join(" ").replace(/\|.*$/,"").trim();
        const atIdx = titlePart.toLowerCase().lastIndexOf(" at ");
        const title = (atIdx > 0 ? titlePart.slice(0, atIdx) : titlePart.split("·")[0]).trim().slice(0,80);
        const fn = words[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
        const ln = words[words.length-1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
        seenNames.add(pname.toLowerCase());
        found.push({
          name: pname, first_name: words[0], last_name: words[words.length-1],
          title: title || null, email: inferEmail(fn, ln, pat, domain),
          email_status: pat ? "likely_to_engage" : "guessed",
          phone_numbers: [], organization: { name: name },
          linkedin_url: url, is_linkedin: true,
        });
      }
    }
    return found;
  }
}
