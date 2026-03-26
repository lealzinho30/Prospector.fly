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

  function extractCNPJ(text) {
    const matches = text.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/g) || [];
    for (const c of matches) {
      const digits = c.replace(/\D/g, "");
      if (digits.length === 14) return digits;
    }
    return null;
  }

  async function fetchProxy(url, timeout = 8000) {
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const r = await fetch(proxyUrl, { signal: controller.signal, headers: { Accept: "application/json" } });
      clearTimeout(timer);
      const data = await r.json();
      return data.contents || "";
    } catch(e) { return ""; }
  }

  try {
    // ── PASSO 1: Lê o site e identifica nome da empresa ──────────────
    let empresaNome = null;
    let cnpjFromSite = null;
    let pattern = null;

    const siteHtml = await fetchProxy(`https://${domain}`);
    if (siteHtml) {
      cnpjFromSite = extractCNPJ(siteHtml);
      const ogName   = siteHtml.match(/property="og:site_name"[^>]*content="([^"]+)"/i)
                    || siteHtml.match(/content="([^"]+)"[^>]*property="og:site_name"/i);
      const titleTag = siteHtml.match(/<title[^>]*>([^<|–\-]{3,60})/i);
      const h1Tag    = siteHtml.match(/<h1[^>]*>([^<]{3,60})<\/h1>/i);
      if (ogName)    empresaNome = ogName[1].trim();
      else if (titleTag) empresaNome = titleTag[1].trim().split(/[-|–]/)[0].trim();
      else if (h1Tag)    empresaNome = h1Tag[1].trim();
    }

    // ── PASSO 2: Hunter.io — padrão email + nome da organização ─────
    try {
      const r = await fetch(
        `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`,
        { headers: { Accept: "application/json" } }
      );
      const d = await r.json();
      if (!empresaNome && d?.data?.organization) empresaNome = d.data.organization;
      pattern = d?.data?.pattern || null;
    } catch(e) {}

    if (!empresaNome) {
      empresaNome = domain.split(".")[0];
      empresaNome = empresaNome.charAt(0).toUpperCase() + empresaNome.slice(1);
    }

    // ── PASSO 3: Busca CNPJ ──────────────────────────────────────────
    let cnpjNum = cnpjFromSite;

    // 3a. Tenta CNPJ.biz via allorigins (muito mais simples que Google)
    if (!cnpjNum) {
      const cnpjBizUrl = `https://cnpj.biz/procura/${encodeURIComponent(empresaNome)}`;
      const cnpjBizHtml = await fetchProxy(cnpjBizUrl, 7000);
      if (cnpjBizHtml) cnpjNum = extractCNPJ(cnpjBizHtml);
    }

    // 3b. Tenta ReceitaWS search
    if (!cnpjNum) {
      try {
        const r = await fetch(
          `https://receitaws.com.br/v1/search/${encodeURIComponent(empresaNome)}`,
          { headers: { Accept: "application/json" } }
        );
        if (r.ok) {
          const d = await r.json();
          const items = Array.isArray(d) ? d : (d.activities ? [d] : []);
          if (items.length) cnpjNum = (items[0].cnpj || "").replace(/\D/g, "");
        }
      } catch(e) {}
    }

    // 3c. BrasilAPI search
    if (!cnpjNum) {
      try {
        const r = await fetch(
          `https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(empresaNome)}&page=1&perPage=5`,
          { headers: { Accept: "application/json" } }
        );
        if (r.ok) {
          const results = await r.json();
          const list = Array.isArray(results) ? results : (results.data || []);
          if (list.length) cnpjNum = (list[0].cnpj || "").replace(/\D/g, "");
        }
      } catch(e) {}
    }

    // 3d. Tenta scrapar a página do CNPJ.biz com o domínio
    if (!cnpjNum) {
      const altUrl = `https://cnpj.biz/procura/${encodeURIComponent(domain)}`;
      const altHtml = await fetchProxy(altUrl, 6000);
      if (altHtml) cnpjNum = extractCNPJ(altHtml);
    }

    // ── PASSO 4: Receita Federal ─────────────────────────────────────
    let cnpjData = null;
    if (cnpjNum) {
      try {
        const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, {
          headers: { Accept: "application/json" }
        });
        if (r.ok) cnpjData = await r.json();
      } catch(e) {}
    }

    const socios = cnpjData?.qsa || [];
    const empresa = cnpjData?.nome_fantasia || cnpjData?.razao_social || empresaNome;
    const cnpjFmted = cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null;

    if (!cnpjNum) {
      return res.status(200).json({
        source: "socios", people: [], empresa: empresaNome, cnpj: null,
        needs_manual: true,
        warning: `Identificamos a empresa como "${empresaNome}" mas não localizamos o CNPJ automaticamente. Cole o CNPJ abaixo para continuar.`
      });
    }

    if (!socios.length) {
      return res.status(200).json({
        source: "socios", people: [], empresa, cnpj: cnpjFmted,
        warning: "CNPJ encontrado, mas sem sócios registrados na Receita Federal."
      });
    }

    // ── PASSO 5: Monta sócios com emails inferidos ───────────────────
    const people = socios.map(s => {
      const nomeCompleto = (s.nome_socio || s.nome || "").trim();
      const partes = nomeCompleto.toLowerCase().split(" ").filter(Boolean);
      const fn = partes[0] || "";
      const ln = partes[partes.length - 1] || "";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio";
      const email = fn
        ? (pattern
            ? pattern.replace("{first}",fn).replace("{last}",ln).replace("{f}",fn[0]||"").replace("{l}",ln[0]||"")+"@"+domain
            : fn+"."+ln+"@"+domain)
        : null;
      return {
        name: nomeCompleto, first_name: fn, last_name: ln, title: qual, email,
        email_status: pattern ? "likely_to_engage" : "guessed",
        phone_numbers: [], organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nomeCompleto+" "+empresa)}`,
        is_socio: true,
      };
    });

    return res.status(200).json({
      source: "socios", people, empresa,
      razao_social: cnpjData?.razao_social, cnpj: cnpjFmted, pattern,
      pagination: { total_entries: people.length },
    });

  } catch(e) {
    return res.status(500).json({ error: "Erro: " + e.message });
  }
};
