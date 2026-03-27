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
  const domPrefix  = domain.split(".")[0];

  // ── Helpers ───────────────────────────────────────────────────────

  async function get(url, headers = {}, timeout = 10000) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeout) });
      return r.ok ? await r.json() : null;
    } catch(e) { return null; }
  }

  async function getProxy(url, timeout = 10000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      return (await r.json()).contents || "";
    } catch(e) { return ""; }
  }

  function inferEmail(fn, ln, pat, dom) {
    fn = (fn||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
    ln = (ln||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
    if (!fn) return null;
    if (pat) return pat.replace("{first}",fn).replace("{last}",ln||"").replace("{f}",fn[0]||"").replace("{l}",(ln||"")[0]||"") + "@" + dom;
    return ln ? `${fn}.${ln}@${dom}` : `${fn}@${dom}`;
  }

  function parseLinkedInResult(raw, linkedInUrl, domain) {
    // Raw: "João Silva - Diretor de Marketing at Cyrela | LinkedIn"
    //   or "Ana Costa · Gerente na Empresa – LinkedIn"
    const parts = raw.split(/\s*[-–|·]\s*/);
    const name  = parts[0].trim().replace(/\s+/g, " ");
    const words = name.split(/\s+/).filter(Boolean);

    if (words.length < 2 || words.length > 5)            return null;
    if (/[\d@<>]/.test(name))                             return null;
    if (/linkedin|loading|erro/i.test(name))              return null;
    if (name.toLowerCase() === domain.split(".")[0])      return null;

    const rest    = parts.slice(1).join(" ").replace(/linkedin/gi,"").trim();
    const atMatch = rest.match(/^(.+?)\s+(?:at|na|em|@)\s+/i);
    const title   = (atMatch ? atMatch[1] : parts[1] || "").replace(/linkedin/gi,"").trim().slice(0, 80);

    return { name, words, title: title || null };
  }

  // ── 0. Get org name + email pattern from Hunter ────────────────────
  let orgName = null, pattern = null;

  const hunterData = await get(
    `https://api.hunter.io/v2/domain-search?api_key=${HUNTER}&domain=${encodeURIComponent(domain)}&limit=10`
  );
  if (hunterData?.data) {
    orgName = hunterData.data.organization || null;
    pattern = hunterData.data.pattern || null;
    if (hunterData.data.emails?.length) {
      // Hunter has real emails — use them and still search LinkedIn
      const hunterPeople = hunterData.data.emails.map(e => ({
        name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
        first_name: e.first_name, last_name: e.last_name,
        email: e.value, email_status: e.confidence >= 70 ? "verified" : "likely_to_engage",
        title: e.position, linkedin_url: e.linkedin || null,
        phone_numbers: [], organization: { name: orgName || domain },
      }));
      const li = await linkedInSearch(domain, orgName, pattern, hunterPeople);
      return res.status(200).json({ source: "hunter", people: [...hunterPeople, ...li].slice(0,20), pattern, orgName, pagination: { total_entries: hunterPeople.length + li.length } });
    }
  }

  // Get org name from site if Hunter didn't return it
  if (!orgName) {
    const siteHtml = await getProxy(`https://${domain}`, 6000);
    const og    = siteHtml.match(/og:site_name"[^>]*content="([^"]+)"/i) || siteHtml.match(/content="([^"]+)"[^>]*og:site_name/i);
    const title = siteHtml.match(/<title[^>]*>([^<|–\-]{3,40})/i);
    if (og)    orgName = og[1].trim();
    else if (title) orgName = title[1].trim().split(/[-|–]/)[0].trim();
    else orgName = domPrefix.charAt(0).toUpperCase() + domPrefix.slice(1);
  }

  const shortName = orgName.split(/\s+/)[0]; // "Cyrela" from "Cyrela Brazil Realty"

  let people = [], source = "";

  // ── 1. Snov.io ────────────────────────────────────────────────────
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
          people = d.emails.map(e => ({ name: [e.firstName, e.lastName].filter(Boolean).join(" ") || null, first_name: e.firstName, last_name: e.lastName, email: e.email, email_status: e.emailStatus === "valid" ? "verified" : "likely_to_engage", title: e.currentPosition?.position || null, linkedin_url: e.linkedInUrl || null, phone_numbers: [], organization: { name: orgName } }));
          source = "snov";
        }
      }
    } catch(e) {}
  }

  // ── 2. Apollo — free endpoint ─────────────────────────────────────
  if (APOLLO_KEY) {
    try {
      const url = `https://api.apollo.io/api/v1/mixed_people/api_search?q_organization_domains[]=${encodeURIComponent(domain)}&person_seniorities[]=c_suite&person_seniorities[]=vp&person_seniorities[]=director&person_seniorities[]=manager&person_seniorities[]=senior&page=1&per_page=25`;
      const d = await get(url, { "X-Api-Key": APOLLO_KEY, "Cache-Control": "no-cache" });
      if (d?.people?.length) {
        const seen = new Set(people.map(p => (p.name||"").toLowerCase()));
        d.people.forEach(p => {
          const nm = [p.first_name, p.last_name].filter(Boolean).join(" ");
          if (seen.has(nm.toLowerCase())) return;
          seen.add(nm.toLowerCase());
          people.push({
            name: nm, first_name: p.first_name, last_name: p.last_name,
            email: inferEmail(p.first_name, p.last_name, pattern, domain),
            email_status: pattern ? "likely_to_engage" : "guessed",
            title: p.title, linkedin_url: p.linkedin_url || null,
            phone_numbers: p.phone_numbers || [], organization: { name: p.organization?.name || orgName },
          });
        });
        if (!source) source = "apollo";
      }
    } catch(e) {}
  }

  // ── 3. LinkedIn — ALWAYS runs, multiple strategies ─────────────────
  const li = await linkedInSearch(domain, shortName, pattern, people);
  const merged = [...people, ...li].slice(0, 20);

  return res.status(200).json({
    source: merged.length ? (people.length ? source : "linkedin") : "none",
    people: merged, pattern, orgName,
    pagination: { total_entries: merged.length },
  });

  // ── LinkedIn search via multiple sources ───────────────────────────
  async function linkedInSearch(domain, name, pat, existing) {
    const seen   = new Set(existing.map(p => (p.name||"").toLowerCase()));
    const found  = [];
    const nameClean = name.replace(/[&]/g, "e").replace(/\s+/g, " ").trim();

    // Strategy A: DuckDuckGo HTML — try multiple queries
    const queries = [
      `site:linkedin.com/in "${nameClean}" Diretor marketing`,
      `site:linkedin.com/in "${nameClean}" Gerente marketing`,
      `site:linkedin.com/in "${nameClean}" CEO OR Presidente`,
      `site:linkedin.com/in "${domain}" Diretor OR Gerente`,
    ];

    for (const q of queries) {
      if (found.length >= 10) break;

      const html = await getProxy(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`,
        10000
      );
      if (!html || html.length < 200) continue;

      // Match all LinkedIn result links
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]*linkedin\.com\/in\/([^"?/]+))[^"]*"[^>]*>([^<]+)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (found.length >= 10) break;
        const rawUrl  = m[1];
        const slug    = m[2];
        const rawText = m[3].trim();

        const parsed = parseLinkedInResult(rawText, rawUrl, domain);
        if (!parsed) continue;
        if (seen.has(parsed.name.toLowerCase())) continue;
        if (slug === domain.split(".")[0].toLowerCase()) continue;

        const cleanUrl = rawUrl.startsWith("http") ? rawUrl.split("?")[0] : `https://www.linkedin.com/in/${slug}`;
        const email    = inferEmail(parsed.words[0], parsed.words[parsed.words.length-1], pat, domain);

        seen.add(parsed.name.toLowerCase());
        found.push({
          name: parsed.name, first_name: parsed.words[0], last_name: parsed.words[parsed.words.length-1],
          title: parsed.title, email,
          email_status: pat ? "likely_to_engage" : "guessed",
          phone_numbers: [], organization: { name: name },
          linkedin_url: cleanUrl, is_linkedin: true,
        });
      }
    }

    // Strategy B: if DuckDuckGo returned nothing, try Google via allorigins
    if (found.length === 0) {
      const googleQ = `site:linkedin.com/in "${nameClean}" Diretor OR Gerente OR CEO -site:linkedin.com/company`;
      const html = await getProxy(
        `https://www.google.com/search?q=${encodeURIComponent(googleQ)}&hl=pt-BR&num=10`,
        10000
      );
      if (html && html.length > 500) {
        // Google format: <h3>Name - Title at Company</h3>
        const linkRe = /linkedin\.com\/in\/([a-z0-9\-]+)/gi;
        const nameRe = /<h3[^>]*>([^<]{10,100})<\/h3>/gi;
        const links = [...html.matchAll(linkRe)].map(m => `https://www.linkedin.com/in/${m[1]}`);
        const names = [...html.matchAll(nameRe)].map(m => m[1].trim());

        names.slice(0, 5).forEach((raw, i) => {
          const parsed = parseLinkedInResult(raw, links[i] || "", domain);
          if (!parsed || seen.has(parsed.name.toLowerCase())) return;
          const email = inferEmail(parsed.words[0], parsed.words[parsed.words.length-1], pat, domain);
          seen.add(parsed.name.toLowerCase());
          found.push({
            name: parsed.name, first_name: parsed.words[0], last_name: parsed.words[parsed.words.length-1],
            title: parsed.title, email,
            email_status: pat ? "likely_to_engage" : "guessed",
            phone_numbers: [], organization: { name: name },
            linkedin_url: links[i] || null, is_linkedin: true,
          });
        });
      }
    }

    return found;
  }
}
