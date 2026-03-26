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

  // Get company name from Hunter or site
  let orgName = null, pattern = null;
  try {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&domain=${encodeURIComponent(domain)}&limit=5`, { headers: { Accept: "application/json" } });
    const d = await r.json();
    orgName  = d.data?.organization || null;
    pattern  = d.data?.pattern || null;
  } catch(e) {}

  if (!orgName) {
    // Get from site og:site_name
    const html = await fetchProxy(`https://${domain}`, 6000);
    const og = html.match(/og:site_name"[^>]*content="([^"]+)"/i) || html.match(/content="([^"]+)"[^>]*og:site_name/i);
    const title = html.match(/<title[^>]*>([^<|–\-]{3,40})/i);
    if (og) orgName = og[1].trim();
    else if (title) orgName = title[1].trim().split(/[-|–]/)[0].trim();
    else orgName = companyGuess;
  }

  const empresa = orgName;
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
            phone_numbers: [], organization: { name: empresa },
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
          phone_numbers: [], organization: { name: empresa }, confidence: e.confidence,
        }));
        source = "hunter";
      }
    } catch(e) {}
  }

  // ── 4. LinkedIn via DuckDuckGo ─────────────────────────────────────
  // Always runs — searches for people who work AT this company
  // Uses company's exact name for precision
  const liPeople = [];
  try {
    const cargos = ["Diretor","Diretora","Gerente","Head","Marketing","Comercial","CEO","Presidente","Fundador","Sócio","Superintendente","Coordenador"];
    // Exact company name in quotes to avoid false positives
    const q = `site:linkedin.com/in "${empresa}" ${cargos.slice(0,4).join(" OR ")}`;
    const html = await fetchProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`, 10000);

    if (html) {
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]*linkedin\.com\/in\/([^"?/]+))[^"]*"[^>]*>([^<]+)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null && liPeople.length < 8) {
        const url = m[1].startsWith("http") ? m[1] : "https://www.linkedin.com/in/"+m[2];
        const raw = m[3].trim();
        // Format: "Nome Sobrenome – Cargo na Empresa | LinkedIn"
        // Split on – or | first
        const segments = raw.split(/\s*[–|\|]\s*/);
        const namePart = segments[0].trim();
        // Title is in segment[1], remove "na/at/em Empresa" suffix
        const titleRaw = (segments[1]||"").replace(/\s+(na|at|em|em|·)\s+.+$/i,"").replace(/linkedin/gi,"").trim();
        const title = titleRaw.slice(0,60) || null;

        // Validate: name should be 2-4 words, no numbers, no "LinkedIn"
        const words = namePart.split(/\s+/).filter(Boolean);
        if (words.length < 2 || words.length > 5) continue;
        if (/[0-9@#]|linkedin/i.test(namePart)) continue;
        const slug = m[2].toLowerCase();
        if (slug === domain.split(".")[0].toLowerCase()) continue;
        if (people.some(p => (p.name||"").toLowerCase() === namePart.toLowerCase())) continue;
        if (liPeople.some(p => p.name.toLowerCase() === namePart.toLowerCase())) continue;
        const name = namePart;

        // Infer email using Hunter pattern or most common BR pattern
        // Use REAL name words, not the potentially corrupted 'words' from above
        const nameWords = name.split(/\s+/).filter(Boolean);
        const fn = nameWords[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
        const ln = nameWords[nameWords.length-1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
        let inferredEmail = null;
        if (fn && ln) {
          if (pattern) {
            inferredEmail = pattern
              .replace("{first}", fn).replace("{last}", ln)
              .replace("{f}", fn[0]||"").replace("{l}", ln[0]||"")
              + "@" + domain;
          } else {
            inferredEmail = fn + "." + ln + "@" + domain;
          }
        }

        liPeople.push({
          name, first_name: words[0], last_name: words[words.length-1],
          title: title || null,
          email: inferredEmail,
          email_status: pattern ? "likely_to_engage" : "guessed",
          email_alternatives: fn && ln ? [
            fn+"@"+domain,
            fn+"."+ln+"@"+domain,
            fn[0]+ln+"@"+domain,
          ].filter(e => e !== inferredEmail) : [],
          phone_numbers: [], organization: { name: empresa },
          linkedin_url: url.split("?")[0],
          is_linkedin: true,
        });
      }
    }
  } catch(e) {}

  const merged = [...people, ...liPeople].slice(0, 20);

  return res.status(200).json({
    source: merged.length ? (people.length ? source : "linkedin") : "none",
    people: merged, pattern, orgName: empresa,
    pagination: { total_entries: merged.length },
  });
}
