module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apolloKey = process.env.APOLLO_API_KEY;
  const hunterKey = process.env.HUNTER_API_KEY || "8f122be7c8440172a49875acc9356073cb141ce2";

  const { company, domain, seniority, department } = req.body;

  const senMap = {
    executive: ["c_suite","owner","founder"],
    senior:    ["vp","director","manager","senior"],
    junior:    ["entry","junior","intern"],
    "":        ["c_suite","vp","director","manager","senior"],
  };

  // ── Tenta Apollo primeiro ──────────────────────────────────────────
  if (apolloKey) {
    try {
      const payload = {
        page: 1,
        per_page: 25,
        person_seniorities: senMap[seniority||""] || senMap[""],
      };
      if (domain)   payload.q_organization_domains = domain;
      if (company)  payload.q_keywords = company;
      if (department) payload.person_departments = [department];

      const r = await fetch("https://api.apollo.io/v1/people/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apolloKey,
          "Cache-Control": "no-cache",
        },
        body: JSON.stringify(payload),
      });

      const d = await r.json();

      // Se deu erro de plano, cai no fallback
      if (d.error && (d.error.includes("free plan") || d.error.includes("not accessible") || d.error.includes("upgrade"))) {
        console.log("Apollo plan error, falling back to Hunter.io");
      } else if (d.people && d.people.length > 0) {
        return res.status(200).json({ source: "apollo", ...d });
      } else if (!d.error) {
        return res.status(200).json({ source: "apollo", people: [], pagination: d.pagination });
      }
    } catch (e) {
      console.log("Apollo error:", e.message);
    }
  }

  // ── Fallback: Hunter.io ────────────────────────────────────────────
  try {
    let url = `https://api.hunter.io/v2/domain-search?api_key=${hunterKey}&limit=20`;
    if (domain)  url += `&domain=${encodeURIComponent(domain)}`;
    if (company) url += `&company=${encodeURIComponent(company)}`;
    if (seniority === "executive") url += "&seniority=executive";
    else if (seniority === "senior") url += "&seniority=senior";
    if (department) url += `&department=${encodeURIComponent(department)}`;

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const d = await r.json();

    if (d.errors) {
      return res.status(400).json({ error: d.errors[0]?.details || "Hunter.io error" });
    }

    const emails = d.data?.emails || [];
    // Normaliza para formato similar ao Apollo
    const people = emails.map(function(e) {
      return {
        name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
        first_name: e.first_name,
        last_name: e.last_name,
        email: e.value,
        email_status: e.confidence >= 75 ? "verified" : e.confidence >= 45 ? "likely_to_engage" : "guessed",
        title: e.position,
        linkedin_url: e.linkedin || null,
        phone_numbers: [],
        organization: { name: company || domain },
        confidence: e.confidence,
      };
    });

    return res.status(200).json({
      source: "hunter",
      people: people,
      pattern: d.data?.pattern,
      pagination: { total_entries: people.length },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
