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

  let people = [];
  let source = "";
  let pattern = null;
  let orgName = null;

  async function fetchProxy(url, timeout = 8000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      const d = await r.json();
      return d.contents || "";
    } catch(e) { return ""; }
  }

  // ── 1. Snov.io ────────────────────────────────────────────────────
  if (snovId && snovSecret) {
    try {
      const tok = await fetch("https://api.snov.io/v1/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: snovId, client_secret: snovSecret }),
      });
      const tokData = await tok.json();
      if (tokData.access_token) {
        const r = await fetch("https://api.snov.io/v2/get-domain-emails-with-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: tokData.access_token, domain, type: "all", limit: 30, lastId: 0 }),
        });
        const d = await r.json();
        if (d.emails && d.emails.length) {
          people = d.emails.map(e => ({
            name: [e.firstName, e.lastName].filter(Boolean).join(" ") || null,
            first_name: e.firstName, last_name: e.lastName,
            email: e.email,
            email_status: e.emailStatus === "valid" ? "verified" : "likely_to_engage",
            title: e.currentPosition?.position || null,
            linkedin_url: e.linkedInUrl || null,
            phone_numbers: [],
            organization: { name: e.currentPosition?.companyName || domain },
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
        body: JSON.stringify({
          page: 1, per_page: 25,
          person_seniorities: ["c_suite","vp","director","manager","senior","owner","founder"],
          q_organization_domains: domain,
        }),
      });
      const d = await r.json();
      const limited = d.error && /free plan|not accessible|upgrade|credits/i.test(d.error);
      if (!limited && d.people && d.people.length) { people = d.people; source = "apollo"; }
    } catch(e) {}
  }

  // ── 3. Hunter.io ──────────────────────────────────────────────────
  if (!people.length) {
    try {
      const r = await fetch(
        `https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&domain=${encodeURIComponent(domain)}&limit=25`,
        { headers: { Accept: "application/json" } }
      );
      const d = await r.json();
      pattern = d.data?.pattern || null;
      orgName = d.data?.organization || null;
      if (d.data?.emails?.length) {
        people = d.data.emails.map(e => ({
          name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
          first_name: e.first_name, last_name: e.last_name,
          email: e.value, email_status: e.confidence >= 70 ? "verified" : "likely_to_engage",
          title: e.position, linkedin_url: e.linkedin || null,
          phone_numbers: [], organization: { name: orgName || domain }, confidence: e.confidence,
        }));
        source = "hunter";
      }
    } catch(e) {}
  }

  // ── 4. LinkedIn Company Page Scrape ───────────────────────────────
  // Scrape public LinkedIn to find employees with their titles
  if (!people.length) {
    try {
      const companySlug = domain.split(".")[0]; // cyrela, eztec, etc
      const searches = [
        `https://www.linkedin.com/company/${companySlug}/people/`,
        `site:linkedin.com/in "${companySlug}" diretor OR gerente OR marketing`,
      ];

      // Try Google search for LinkedIn profiles
      const googleUrl = `https://www.google.com/search?q=site:linkedin.com/in+%22${companySlug}%22+%22diretor%22+OR+%22gerente%22+OR+%22marketing%22&hl=pt-BR&num=10`;
      const googleHtml = await fetchProxy(googleUrl, 8000);
      
      if (googleHtml) {
        // Extract names and titles from Google results
        const nameMatches = googleHtml.match(/linkedin\.com\/in\/[^"'\s]+/g) || [];
        const snippets = googleHtml.match(/<span[^>]*>([^<]{10,80}(?:Diretor|Gerente|Direto|Director|Manager|CEO|CMO|Marketing|Comercial)[^<]{0,60})<\/span>/gi) || [];
        
        const extracted = [];
        snippets.slice(0, 8).forEach(s => {
          const clean = s.replace(/<[^>]+>/g, "").trim();
          if (clean.length > 5 && !extracted.find(e => e.title === clean)) {
            // Try to parse "Name - Title at Company" format
            const parts = clean.split(/\s*[-–]\s*/);
            if (parts.length >= 2) {
              extracted.push({
                name: parts[0].trim(),
                title: parts[1].trim(),
                email: null, email_status: "guessed",
                phone_numbers: [],
                organization: { name: orgName || domain },
                linkedin_url: nameMatches[extracted.length] ? "https://www." + nameMatches[extracted.length] : null,
              });
            }
          }
        });

        if (extracted.length) { people = extracted; source = "linkedin_search"; }
      }
    } catch(e) {}
  }

  // ── 5. Site /equipe or /sobre page ────────────────────────────────
  if (!people.length) {
    try {
      const pages = [`https://${domain}/equipe`, `https://${domain}/sobre`, `https://${domain}/time`, `https://${domain}/contato`];
      for (const url of pages) {
        if (people.length) break;
        const html = await fetchProxy(url, 5000);
        if (!html) continue;
        const emailMatches = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []))]
          .filter(e => !e.includes("noreply") && !e.includes("example") && !e.includes("test"))
          .slice(0, 8);
        if (emailMatches.length) {
          people = emailMatches.map(e => ({ name: null, email: e, email_status: "likely_to_engage", title: null, phone_numbers: [], organization: { name: domain } }));
          source = "site";
        }
      }
    } catch(e) {}
  }

  // ── 6. If still nothing: infer from CNPJ QSA + email pattern ─────
  // Return empty with pattern for the socios endpoint to handle
  return res.status(200).json({
    source: source || "none",
    people,
    pattern,
    orgName,
    pagination: { total_entries: people.length },
  });
}
