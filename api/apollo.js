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

  // ── 1. Snov.io ────────────────────────────────────────────────────
  if (snovId && snovSecret && !people.length) {
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
      if (!limited && d.people && d.people.length) {
        people = d.people;
        source = "apollo";
      }
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
      if (d.data?.emails?.length) {
        people = d.data.emails.map(e => ({
          name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
          first_name: e.first_name, last_name: e.last_name,
          email: e.value,
          email_status: e.confidence >= 75 ? "verified" : "likely_to_engage",
          title: e.position, linkedin_url: e.linkedin || null,
          phone_numbers: [], organization: { name: domain }, confidence: e.confidence,
        }));
        source = "hunter";
      }
    } catch(e) {}
  }

  // ── 4. Scrape LinkedIn via allorigins ─────────────────────────────
  // If still no results, scrape the company website for team/about pages
  if (!people.length) {
    try {
      const pages = [
        `https://${domain}/sobre`, `https://${domain}/equipe`, `https://${domain}/time`,
        `https://${domain}/contato`, `https://${domain}/about`, `https://${domain}/team`,
      ];
      for (const url of pages) {
        if (people.length) break;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const r = await fetch(proxyUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        const html = d.contents || "";
        if (!html) continue;

        // Extract emails from page
        const emailMatches = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
        const validEmails = [...new Set(emailMatches)].filter(e =>
          e.includes(domain.split(".")[0]) && !e.includes("noreply") && !e.includes("no-reply")
        );
        if (validEmails.length) {
          people = validEmails.slice(0, 8).map(e => ({
            name: null, email: e,
            email_status: "likely_to_engage", title: null,
            phone_numbers: [], organization: { name: domain },
          }));
          source = "site";
        }
      }
    } catch(e) {}
  }

  return res.status(200).json({ source, people, pattern, pagination: { total_entries: people.length } });
}
