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

  const snovId     = process.env.SNOV_CLIENT_ID;
  const snovSecret = process.env.SNOV_CLIENT_SECRET;
  const hunterKey  = "8f122be7c8440172a49875acc9356073cb141ce2";

  // ── 1. Snov.io ───────────────────────────────────────────────────
  if (snovId && snovSecret) {
    try {
      // Get OAuth token
      const tokenRes = await fetch("https://api.snov.io/v1/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: snovId, client_secret: snovSecret }),
      });
      const tokenData = await tokenRes.json();
      const token = tokenData.access_token;

      if (token) {
        // Search emails by domain
        const searchRes = await fetch("https://api.snov.io/v2/get-domain-emails-with-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: token, domain, type: "all", limit: 30, lastId: 0 }),
        });
        const searchData = await searchRes.json();
        const emails = searchData.emails || [];

        if (emails.length > 0) {
          const targetRoles = ["diretor","diretora","gerente","ceo","cmo","presidente","founder","sócio","marketing","comercial","vp","superintendente","coordenador"];
          const people = emails.map(e => {
            const name = [e.firstName, e.lastName].filter(Boolean).join(" ");
            const title = e.currentPosition?.position || e.position || "";
            const isTarget = targetRoles.some(r => title.toLowerCase().includes(r));
            return {
              name: name || null,
              first_name: e.firstName || null,
              last_name: e.lastName || null,
              email: e.email,
              email_status: e.emailStatus === "valid" ? "verified" : e.emailStatus === "accept_all" ? "likely_to_engage" : "guessed",
              title,
              is_target: isTarget,
              linkedin_url: e.linkedInUrl || e.linkedin || null,
              phone_numbers: [],
              organization: { name: e.currentPosition?.companyName || domain },
              photo_url: null,
            };
          });

          // Sort: decisores primeiro
          people.sort((a, b) => (b.is_target ? 1 : 0) - (a.is_target ? 1 : 0));

          return res.status(200).json({
            source: "snov",
            people,
            pagination: { total_entries: people.length },
          });
        }
      }
    } catch(e) {
      console.log("Snov.io error:", e.message);
    }
  }

  // ── 2. Apollo.io ─────────────────────────────────────────────────
  const apolloKey = process.env.APOLLO_API_KEY;
  if (apolloKey) {
    try {
      const senMap = {
        executive: ["c_suite","owner","founder"],
        senior:    ["vp","director","manager","senior"],
        junior:    ["entry","junior","intern"],
        "":        ["c_suite","vp","director","manager","senior"],
      };
      const payload = {
        page: 1, per_page: 25,
        person_seniorities: senMap[seniority||""],
        q_organization_domains: domain,
      };
      if (department) payload.person_departments = [department];

      const r = await fetch("https://api.apollo.io/v1/people/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apolloKey, "Cache-Control": "no-cache" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      const limited = d.error && /free plan|not accessible|upgrade|credits/i.test(d.error);
      if (!limited && d.people && d.people.length > 0) {
        return res.status(200).json({ source: "apollo", ...d });
      }
    } catch(e) {}
  }

  // ── 3. Hunter.io fallback ─────────────────────────────────────────
  try {
    let url = `https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&limit=25&domain=${encodeURIComponent(domain)}`;
    if (department) url += `&department=${encodeURIComponent(department)}`;
    if (seniority === "executive") url += "&seniority=executive";
    else if (seniority === "senior") url += "&seniority=senior";

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const d = await r.json();

    const hasData = d.data?.emails?.length > 0;
    if (!hasData && d.errors) return res.status(400).json({ error: "Nenhum contato encontrado para este domínio." });

    const people = (d.data?.emails || []).map(e => ({
      name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
      first_name: e.first_name, last_name: e.last_name,
      email: e.value,
      email_status: e.confidence >= 75 ? "verified" : e.confidence >= 45 ? "likely_to_engage" : "guessed",
      title: e.position, linkedin_url: e.linkedin || null,
      phone_numbers: [], organization: { name: domain }, confidence: e.confidence,
    }));

    return res.status(200).json({
      source: "hunter", people,
      pattern: d.data?.pattern,
      pagination: { total_entries: people.length },
    });
  } catch(e) {
    return res.status(500).json({ error: "Falha: " + e.message });
  }
}
