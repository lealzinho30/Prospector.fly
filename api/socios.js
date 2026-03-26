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

  const hunterKey = "8f122be7c8440172a49875acc9356073cb141ce2";

  function extractCNPJ(text) {
    const m = text.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/g) || [];
    for (const c of m) {
      const d = c.replace(/\D/g, "");
      if (d.length === 14) return d;
    }
    return null;
  }

  async function fetchProxy(url, timeout = 7000) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeout),
      });
      const d = await r.json();
      return d.contents || "";
    } catch(e) { return ""; }
  }

  try {
    // ── 1. Descobre nome e padrão de email ────────────────────────────
    let empresaNome = null;
    let pattern = null;
    let cnpjFromSite = null;

    // Hunter.io: nome da empresa + padrão de email
    try {
      const r = await fetch(
        `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${hunterKey}&limit=3`,
        { headers: { Accept: "application/json" } }
      );
      const d = await r.json();
      empresaNome = d.data?.organization || null;
      pattern = d.data?.pattern || null;
    } catch(e) {}

    // Site: título da página + CNPJ no HTML
    const siteHtml = await fetchProxy(`https://${domain}`);
    if (siteHtml) {
      cnpjFromSite = extractCNPJ(siteHtml);
      if (!empresaNome) {
        const og = siteHtml.match(/property="og:site_name"[^>]*content="([^"]+)"/i)
                || siteHtml.match(/content="([^"]+)"[^>]*property="og:site_name"/i);
        const title = siteHtml.match(/<title[^>]*>([^<|–\-]{3,60})/i);
        if (og) empresaNome = og[1].trim();
        else if (title) empresaNome = title[1].trim().split(/[-|–]/)[0].trim();
      }
    }

    if (!empresaNome) {
      empresaNome = domain.split(".")[0];
      empresaNome = empresaNome.charAt(0).toUpperCase() + empresaNome.slice(1);
    }

    // ── 2. Encontra CNPJ ──────────────────────────────────────────────
    let cnpjNum = cnpjFromSite;

    if (!cnpjNum) {
      // cnpj.biz search
      const biz = await fetchProxy(`https://cnpj.biz/procura/${encodeURIComponent(empresaNome)}`);
      if (biz) cnpjNum = extractCNPJ(biz);
    }

    if (!cnpjNum) {
      // BrasilAPI search
      try {
        const r = await fetch(
          `https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(empresaNome)}&page=1&perPage=3`,
          { headers: { Accept: "application/json" } }
        );
        if (r.ok) {
          const list = await r.json();
          const items = Array.isArray(list) ? list : (list.data || []);
          if (items.length) cnpjNum = (items[0].cnpj || "").replace(/\D/g, "");
        }
      } catch(e) {}
    }

    // ── 3. Busca dados completos na Receita Federal ───────────────────
    let cnpjData = null;
    if (cnpjNum) {
      try {
        const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNum}`, {
          headers: { Accept: "application/json" }
        });
        if (r.ok) cnpjData = await r.json();
      } catch(e) {}
    }

    // QSA = Quadro de Sócios e Administradores (inclui diretores, gerentes)
    const qsa = cnpjData?.qsa || [];
    const empresa = cnpjData?.nome_fantasia || cnpjData?.razao_social || empresaNome;
    const cnpjFmt = cnpjNum ? cnpjNum.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : null;

    if (!cnpjNum) {
      return res.status(200).json({
        source: "socios", people: [], empresa: empresaNome, cnpj: null,
        needs_manual: true,
        warning: `Identificamos a empresa como "${empresaNome}" mas não encontramos o CNPJ automaticamente.`,
      });
    }

    if (!qsa.length) {
      return res.status(200).json({
        source: "socios", people: [], empresa, cnpj: cnpjFmt,
        warning: "CNPJ encontrado mas sem sócios/administradores registrados.",
      });
    }

    // ── 4. Monta contatos com emails inferidos ────────────────────────
    const people = qsa.map(s => {
      const nomeCompleto = (s.nome_socio || s.nome || "").trim();
      const partes = nomeCompleto.toLowerCase().split(" ").filter(Boolean);
      const fn = partes[0] || "";
      const ln = partes[partes.length - 1] || "";
      const qual = s.qualificacao_socio || s.descricao_qualificacao_socio || "Sócio / Administrador";

      // Infere email pelo padrão detectado pelo Hunter
      let email = null;
      if (fn && domain) {
        if (pattern) {
          email = pattern
            .replace("{first}", fn).replace("{last}", ln)
            .replace("{f}", fn[0] || "").replace("{l}", ln[0] || "")
            + "@" + domain;
        } else {
          // Tenta os 3 padrões mais comuns no BR
          email = fn + "." + ln + "@" + domain; // joao.silva@empresa.com.br
        }
      }

      return {
        name: nomeCompleto,
        first_name: fn, last_name: ln,
        title: qual, email,
        email_status: pattern ? "likely_to_engage" : "guessed",
        email_alternatives: fn ? [
          fn + "@" + domain,
          fn + "." + ln + "@" + domain,
          fn[0] + ln + "@" + domain,
        ] : [],
        phone_numbers: [],
        organization: { name: empresa },
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nomeCompleto + " " + empresa)}`,
        is_socio: true,
      };
    });

    return res.status(200).json({
      source: "socios", people, empresa,
      razao_social: cnpjData?.razao_social,
      cnpj: cnpjFmt, pattern,
      pagination: { total_entries: people.length },
    });

  } catch(e) {
    return res.status(500).json({ error: "Erro: " + e.message });
  }
}
