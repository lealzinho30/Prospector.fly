module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  const { domain } = body;
  if (!domain) return res.status(400).json({ error: "Informe o domínio da empresa." });

  const hunterKey = "8f122be7c8440172a49875acc9356073cb141ce2";

  try {
    // ── PASSO 1: Identifica o nome da empresa via Hunter ─────────────
    let empresaNome = null;
    let pattern = null;

    try {
      const hunterUrl = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`;
      const hunterRes = await fetch(hunterUrl, { headers: { Accept: "application/json" } });
      const hunterData = await hunterRes.json();
      empresaNome = hunterData?.data?.organization || null;
      pattern = hunterData?.data?.pattern || null;
    } catch(e) {}

    // Fallback: deriva o nome do domínio
    if (!empresaNome) {
      empresaNome = domain.split(".")[0];
      empresaNome = empresaNome.charAt(0).toUpperCase() + empresaNome.slice(1);
    }

    // ── PASSO 2: Busca CNPJ pelo nome identificado ───────────────────
    let cnpjNum = null;
    let cnpjData = null;
    let empresa = empresaNome;

    // Tenta BrasilAPI search
    const queries = [empresaNome, domain.split(".")[0]];
    for (const q of queries) {
      if (cnpjNum) break;
      try {
        const searchRes = await fetch(
          `https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(q)}&page=1&perPage=3`,
          { headers: { Accept: "application/json" } }
        );
        if (searchRes.ok) {
          const results = await searchRes.json();
          const list = Array.isArray(results) ? results : (results.data || []);
          if (list.length > 0) {
            cnpjNum = (list[0].cnpj || "").replace(/\D/g, "");
            empresa = list[0].razao_social || list[0].nome_fantasia || empresaNome;
          }
        }
      } catch(e) {}
    }

    // ── PASSO 3: Busca dados completos do CNPJ ───────────────────────
    if (cnpjNum) {
      try {
        const cnpjRes = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, {
          headers: { Accept: "application/json" }
        });
        if (cnpjRes.ok) cnpjData = await cnpjRes.json();
      } catch(e) {}
    }

    const socios = cnpjData?.qsa || [];

    if (!socios.length && !cnpjNum) {
      return res.status(200).json({
        source: "socios", people: [], empresa, cnpj: null,
        warning: `Não encontramos CNPJ para "${empresaNome}". Cole o CNPJ diretamente na aba CNPJ para buscar os sócios.`
      });
    }

    // ── PASSO 4: Monta contatos dos sócios ───────────────────────────
    const people = socios.map(s => {
      const nomeCompleto = (s.nome_socio || s.nome || "").trim();
      const partes = nomeCompleto.toLowerCase().split(" ").filter(Boolean);
      const firstName = partes[0] || "";
      const lastName = partes[partes.length - 1] || "";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio";

      let email = null;
      if (firstName) {
        if (pattern) {
          email = pattern
            .replace("{first}", firstName)
            .replace("{last}", lastName)
            .replace("{f}", firstName[0] || "")
            .replace("{l}", lastName[0] || "")
            + "@" + domain;
        } else {
          email = firstName + "." + lastName + "@" + domain;
        }
      }

      return {
        name: nomeCompleto,
        first_name: firstName,
        last_name: lastName,
        title: qual,
        email,
        email_status: pattern ? "likely_to_engage" : "guessed",
        phone_numbers: [],
        organization: { name: cnpjData?.nome_fantasia || empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nomeCompleto + " " + (cnpjData?.nome_fantasia || empresa))}`,
        is_socio: true,
      };
    });

    return res.status(200).json({
      source: "socios",
      people,
      empresa: cnpjData?.nome_fantasia || cnpjData?.razao_social || empresa,
      razao_social: cnpjData?.razao_social,
      cnpj: cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null,
      pattern,
      pagination: { total_entries: people.length },
    });

  } catch(e) {
    return res.status(500).json({ error: "Erro: " + e.message });
  }
};
