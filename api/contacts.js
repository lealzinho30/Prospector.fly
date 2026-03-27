export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  const { domain, empresa } = body;
  if (!domain) return res.status(400).json({ error: "Informe o domínio." });

  const HUNTER     = "8f122be7c8440172a49875acc9356073cb141ce2";
  const SNOV_ID    = process.env.SNOV_CLIENT_ID;
  const SNOV_SEC   = process.env.SNOV_CLIENT_SECRET;
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  const ANTHROPIC  = process.env.ANTHROPIC_API_KEY;

  const nomeEmpresa = empresa || domain.split(".")[0];

  async function callAPI(url, opts = {}) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
      return r.ok ? await r.json() : null;
    } catch(e) { return null; }
  }

  function inferEmail(fn, ln, pattern, dom) {
    fn = (fn||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
    ln = (ln||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z]/g,"");
    if (!fn) return null;
    if (pattern) return pattern.replace("{first}",fn).replace("{last}",ln||"").replace("{f}",fn[0]||"").replace("{l}",(ln||"")[0]||"") + "@" + dom;
    return ln ? `${fn}.${ln}@${dom}` : `${fn}@${dom}`;
  }

  let people = [], pattern = null, orgName = nomeEmpresa, source = "";

  // ── 1. Hunter.io ──────────────────────────────────────────────────
  const hunterData = await callAPI(
    `https://api.hunter.io/v2/domain-search?api_key=${HUNTER}&domain=${encodeURIComponent(domain)}&limit=10`
  );
  if (hunterData?.data) {
    orgName  = hunterData.data.organization || orgName;
    pattern  = hunterData.data.pattern || null;
    if (hunterData.data.emails?.length) {
      people = hunterData.data.emails.map(e => ({
        name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
        first_name: e.first_name, last_name: e.last_name,
        email: e.value, email_status: e.confidence >= 70 ? "verified" : "likely_to_engage",
        title: e.position, linkedin_url: e.linkedin || null,
        phone_numbers: [], organization: { name: orgName },
      }));
      source = "hunter";
    }
  }

  // ── 2. Snov.io ────────────────────────────────────────────────────
  if (!people.length && SNOV_ID && SNOV_SEC) {
    try {
      const tok = await fetch("https://api.snov.io/v1/oauth/access_token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: SNOV_ID, client_secret: SNOV_SEC }),
        signal: AbortSignal.timeout(8000),
      });
      const { access_token } = await tok.json();
      if (access_token) {
        const r = await fetch("https://api.snov.io/v2/get-domain-emails-with-info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token, domain, type: "all", limit: 30, lastId: 0 }),
          signal: AbortSignal.timeout(10000),
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

  // ── 3. Apollo free endpoint ───────────────────────────────────────
  if (APOLLO_KEY) {
    const aData = await callAPI(
      `https://api.apollo.io/api/v1/mixed_people/api_search?q_organization_domains[]=${encodeURIComponent(domain)}&person_seniorities[]=c_suite&person_seniorities[]=vp&person_seniorities[]=director&person_seniorities[]=manager&page=1&per_page=25`,
      { headers: { "X-Api-Key": APOLLO_KEY, "Content-Type": "application/json", "Cache-Control": "no-cache" } }
    );
    if (aData?.people?.length) {
      const seen = new Set(people.map(p => (p.name||"").toLowerCase()));
      aData.people.forEach(p => {
        const nm = [p.first_name, p.last_name].filter(Boolean).join(" ");
        if (!nm || seen.has(nm.toLowerCase())) return;
        seen.add(nm.toLowerCase());
        people.push({
          name: nm, first_name: p.first_name, last_name: p.last_name,
          email: inferEmail(p.first_name, p.last_name, pattern, domain),
          email_status: pattern ? "likely_to_engage" : "guessed",
          title: p.title, linkedin_url: p.linkedin_url || null,
          phone_numbers: p.phone_numbers || [], organization: { name: orgName },
        });
      });
      if (!source && people.length) source = "apollo";
    }
  }

  // ── 4. Claude + web_search — O que realmente funciona ─────────────
  // Use Claude with built-in web search to find LinkedIn profiles + emails
  if (ANTHROPIC) {
    try {
      const prompt = `Você é um pesquisador de leads B2B especializado no mercado imobiliário brasileiro.

Pesquise no LinkedIn e na web os decisores da empresa "${orgName}" (domínio: ${domain}).
Quero encontrar: Diretor de Marketing, Gerente de Marketing, CMO, CEO, Presidente, Diretor Comercial ou cargos similares.

Para cada pessoa encontrada, retorne:
- Nome completo
- Cargo exato
- URL do LinkedIn (linkedin.com/in/...)
- Email (se encontrado) ou email inferido pelo padrão do domínio

Retorne SOMENTE um array JSON válido, sem texto adicional:
[{"name":"Nome Completo","title":"Cargo","linkedin_url":"https://linkedin.com/in/slug","email":"email@${domain}","email_status":"found|inferred"}]

Se não encontrar ninguém, retorne [].`;

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      const claudeData = await claudeRes.json();
      const textBlocks = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("");

      if (textBlocks) {
        const match = textBlocks.match(/\[[\s\S]*\]/);
        if (match) {
          const claudePeople = JSON.parse(match[0]);
          const seen = new Set(people.map(p => (p.name||"").toLowerCase()));
          claudePeople.forEach(p => {
            if (!p.name || seen.has(p.name.toLowerCase())) return;
            seen.add(p.name.toLowerCase());
            const words = p.name.split(" ");
            const fn = words[0], ln = words[words.length-1];
            const email = p.email || inferEmail(fn, ln, pattern, domain);
            people.push({
              name: p.name,
              first_name: fn, last_name: ln,
              email: email,
              email_status: p.email_status === "found" ? "verified" : (pattern ? "likely_to_engage" : "guessed"),
              title: p.title,
              linkedin_url: p.linkedin_url || null,
              phone_numbers: [],
              organization: { name: orgName },
              is_claude: true,
            });
          });
          if (!source && people.length) source = "claude_search";
        }
      }
    } catch(e) {}
  }

  return res.status(200).json({
    source: people.length ? source : "none",
    people: people.slice(0, 20),
    pattern, orgName,
    pagination: { total_entries: people.length },
  });
}
