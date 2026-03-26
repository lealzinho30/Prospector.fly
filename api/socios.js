module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch(e) { body = {}; } }

  const { company, domain } = body;
  if (!company && !domain) return res.status(400).json({ error: "Informe empresa ou domínio." });

  const hunterKey = "8f122be7c8440172a49875acc9356073cb141ce2";
  const nome = company || (domain || "").split(".")[0];

  try {
    // ── PASSO 1: Busca CNPJ pelo nome da empresa ────────────────────
    const searchUrl = `https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(nome)}&page=1&perPage=5`;
    const searchRes = await fetch(searchUrl, { headers: { Accept: "application/json" } });
    let cnpjs = [];

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      cnpjs = Array.isArray(searchData) ? searchData : (searchData.data || []);
    }

    // Fallback: tenta ReceitaWS search
    if (!cnpjs.length) {
      const rwUrl = `https://www.receitaws.com.br/v1/search/${encodeURIComponent(nome)}`;
      try {
        const rwRes = await fetch(rwUrl, { headers: { Accept: "application/json" } });
        if (rwRes.ok) {
          const rwData = await rwRes.json();
          if (rwData.activities) cnpjs = [rwData];
          else if (Array.isArray(rwData)) cnpjs = rwData;
        }
      } catch(e) {}
    }

    if (!cnpjs.length) {
      return res.status(200).json({ source: "socios", people: [], warning: "CNPJ não encontrado para '"+nome+"'. Tente o nome exato da empresa." });
    }

    // ── PASSO 2: Pega sócios do CNPJ encontrado ──────────────────────
    const cnpjNum = (cnpjs[0].cnpj || cnpjs[0].taxId || "").replace(/\D/g,"");
    const empresa = cnpjs[0].razao_social || cnpjs[0].company || nome;

    if (!cnpjNum) {
      return res.status(200).json({ source: "socios", people: [], warning: "CNPJ inválido para '"+nome+"'." });
    }

    const cnpjRes = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, { headers: { Accept: "application/json" } });
    if (!cnpjRes.ok) {
      return res.status(200).json({ source: "socios", people: [], warning: "Não foi possível buscar o CNPJ "+cnpjNum+"." });
    }

    const cnpjData = await cnpjRes.json();
    const socios = cnpjData.qsa || [];

    if (!socios.length) {
      return res.status(200).json({ source: "socios", people: [], empresa, cnpj: cnpjNum, warning: "Nenhum sócio registrado para este CNPJ." });
    }

    // ── PASSO 3: Busca padrão de email via Hunter ────────────────────
    let pattern = null;
    if (domain) {
      try {
        const hunterUrl = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=5`;
        const hunterRes = await fetch(hunterUrl, { headers: { Accept: "application/json" } });
        const hunterData = await hunterRes.json();
        pattern = hunterData?.data?.pattern || null;
      } catch(e) {}
    }

    // ── PASSO 4: Monta contatos dos sócios ───────────────────────────
    const people = socios.map(function(s) {
      const nomeCompleto = (s.nome_socio || s.nome || "").trim();
      const partes = nomeCompleto.toLowerCase().split(" ");
      const firstName = partes[0] || "";
      const lastName = partes[partes.length-1] || "";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio";

      let email = null;
      if (domain && firstName) {
        if (pattern) {
          email = pattern
            .replace("{first}", firstName)
            .replace("{last}", lastName)
            .replace("{f}", firstName[0] || "")
            .replace("{l}", lastName[0] || "")
            + "@" + domain;
        } else {
          // Padrões mais comuns no BR
          email = firstName + "." + lastName + "@" + domain;
        }
      }

      return {
        name: nomeCompleto,
        first_name: firstName,
        last_name: lastName,
        title: qual,
        email: email,
        email_status: pattern ? "likely_to_engage" : "guessed",
        phone_numbers: [],
        organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nomeCompleto)}`,
        is_socio: true,
      };
    });

    return res.status(200).json({
      source: "socios",
      people,
      empresa,
      cnpj: cnpjNum,
      pattern,
      pagination: { total_entries: people.length },
    });

  } catch(e) {
    return res.status(500).json({ error: "Erro: " + e.message });
  }
};
