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
    // ── PASSO 1: Scrapa o site e extrai CNPJ diretamente ─────────────
    let cnpjFromSite = null;
    let empresaNomeSite = null;
    let pattern = null;

    // Tenta buscar o site via allorigins
    const siteUrls = [
      `https://${domain}`,
      `https://${domain}/contato`,
      `https://${domain}/sobre`,
      `https://${domain}/quem-somos`,
    ];

    for (const url of siteUrls) {
      if (cnpjFromSite) break;
      try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const proxyRes = await fetch(proxyUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        if (!proxyRes.ok) continue;
        const proxy = await proxyRes.json();
        const html = proxy.contents || "";

        // Extrai CNPJ do HTML (padrão XX.XXX.XXX/XXXX-XX)
        const cnpjMatch = html.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/g);
        if (cnpjMatch) {
          // Pega o primeiro CNPJ válido (14 dígitos)
          for (const c of cnpjMatch) {
            const digits = c.replace(/\D/g, "");
            if (digits.length === 14) { cnpjFromSite = digits; break; }
          }
        }

        // Extrai nome da empresa do título ou meta
        if (!empresaNomeSite) {
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          if (titleMatch) empresaNomeSite = titleMatch[1].replace(/\s*[-|].*$/, "").trim();
          const ogMatch = html.match(/<meta[^>]*property="og:site_name"[^>]*content="([^"]+)"/i)
                       || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:site_name"/i);
          if (ogMatch) empresaNomeSite = ogMatch[1].trim();
        }

        if (cnpjFromSite) break;
      } catch(e) {}
    }

    // ── PASSO 2: Busca padrão email via Hunter ───────────────────────
    try {
      const hunterUrl = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`;
      const hunterRes = await fetch(hunterUrl, { headers: { Accept: "application/json" } });
      const hunterData = await hunterRes.json();
      if (!empresaNomeSite) empresaNomeSite = hunterData?.data?.organization || null;
      pattern = hunterData?.data?.pattern || null;
    } catch(e) {}

    // ── PASSO 3: Busca CNPJ na Receita Federal ───────────────────────
    let cnpjData = null;
    let cnpjNum = cnpjFromSite;

    if (cnpjNum) {
      // Achou CNPJ no site — busca direto
      try {
        const cnpjRes = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, { headers: { Accept: "application/json" } });
        if (cnpjRes.ok) cnpjData = await cnpjRes.json();
      } catch(e) {}
    } else {
      // Não achou CNPJ no site — busca pelo nome identificado
      const searchName = empresaNomeSite || domain.split(".")[0];
      try {
        const searchRes = await fetch(
          `https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(searchName)}&page=1&perPage=5`,
          { headers: { Accept: "application/json" } }
        );
        if (searchRes.ok) {
          const results = await searchRes.json();
          const list = Array.isArray(results) ? results : (results.data || []);
          if (list.length > 0) {
            cnpjNum = (list[0].cnpj || "").replace(/\D/g, "");
            const cnpjRes = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, { headers: { Accept: "application/json" } });
            if (cnpjRes.ok) cnpjData = await cnpjRes.json();
          }
        }
      } catch(e) {}
    }

    const socios = cnpjData?.qsa || [];
    const empresa = cnpjData?.nome_fantasia || cnpjData?.razao_social || empresaNomeSite || domain;

    if (!cnpjData && !cnpjFromSite) {
      return res.status(200).json({
        source: "socios", people: [], empresa, cnpj: null,
        warning: `Não encontramos o CNPJ no site "${domain}". Cole o CNPJ diretamente na aba CNPJ para buscar os sócios.`
      });
    }

    if (!socios.length) {
      return res.status(200).json({
        source: "socios", people: [], empresa,
        cnpj: cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null,
        warning: "CNPJ encontrado, mas sem sócios registrados na Receita Federal."
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
        email = pattern
          ? pattern.replace("{first}", firstName).replace("{last}", lastName).replace("{f}", firstName[0] || "").replace("{l}", lastName[0] || "") + "@" + domain
          : firstName + "." + lastName + "@" + domain;
      }

      return {
        name: nomeCompleto,
        first_name: firstName,
        last_name: lastName,
        title: qual,
        email,
        email_status: pattern ? "likely_to_engage" : "guessed",
        phone_numbers: [],
        organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nomeCompleto + " " + empresa)}`,
        is_socio: true,
      };
    });

    return res.status(200).json({
      source: "socios", people, empresa,
      razao_social: cnpjData?.razao_social,
      cnpj: cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null,
      cnpj_found_on_site: !!cnpjFromSite,
      pattern,
      pagination: { total_entries: people.length },
    });

  } catch(e) {
    return res.status(500).json({ error: "Erro: " + e.message });
  }
};
