// Independent web search module for live prices, news, and facts without Google Search quota.

/**
 * Extracts a clean search query from user prompt by stripping bot commands, wake words, and filler phrasing.
 */
export function extractSearchQuery(rawText) {
  let q = String(rawText || "").trim();
  // Strip commands: /search, /google, /find, /جستجو, /سرچ
  q = q.replace(/^\/(search|google|find|جستجو|سرچ)(?:@\S+)?\s*/i, "");
  // Strip wake word سید
  q = q.replace(/(?<![\p{L}])سید(?![\p{L}])/gu, " ");
  // Strip explicit search filler phrases
  q = q.replace(/(?:سرچ|جستجو|گوگل|توی\s*گوگل|تو\s*گوگل|توی\s*نت|تو\s*نت|برام\s*سرچ|آنلاین\s*بگرد|چک\s*کن)\s*(?:کن|بزن|کنید|کنی|بگرد)?/gi, " ");
  // Clean punctuation and excess whitespace
  q = q.replace(/[؟?!\.,؛،:]+/g, " ").replace(/\s+/g, " ").trim();
  return q.length >= 2 ? q : String(rawText || "").trim();
}

/**
 * Clean HTML markup and basic entities.
 */
function cleanHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Perform a fast, zero-dependency web search via DuckDuckGo HTML.
 * Returns { ok: boolean, query: string, text: string, sources: Array<{ title: string, url: string }> }
 */
export async function searchWeb(query, opts = {}) {
  const cleanQ = String(query || "").trim();
  if (!cleanQ) {
    return { ok: false, query: "", text: "", sources: [] };
  }

  const maxResults = opts.maxResults ?? 5;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQ)}`;
    const res = await fetch(url, {
      signal: controller?.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fa,en-US;q=0.9,en;q=0.8",
      },
    });

    if (!res.ok) {
      return { ok: false, query: cleanQ, text: "", sources: [] };
    }

    const html = await res.text();
    const results = [];
    const seen = new Set();

    // DuckDuckGo separates results with result / results_links classes
    const blocks = html.split(/class=["']result\s+results_links/i);
    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];

      const titleMatch = /class=["']result__title["'][\s\S]*?<a[^>]+>([\s\S]*?)<\/a>/i.exec(block);
      let title = titleMatch ? cleanHtml(titleMatch[1]) : "";

      const urlMatch = /href=["'](?:\/\/duckduckgo\.com\/l\/\?uddg=)?([^\s"'&]+)/i.exec(block);
      let rawUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : "";
      if (rawUrl && !rawUrl.startsWith("http")) rawUrl = `https://${rawUrl}`;

      const snippetMatch = /class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      let snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : "";

      if (snippet && rawUrl && !seen.has(rawUrl)) {
        seen.add(rawUrl);
        results.push({
          title: title || "منبع وب",
          url: rawUrl,
          snippet,
        });
      }
    }

    if (!results.length) {
      return { ok: false, query: cleanQ, text: "", sources: [] };
    }

    // Format grounded context for the AI prompt
    const lines = results.map(
      (r, idx) => `[منبع ${idx + 1}: ${r.title} | ${r.url}]\n${r.snippet}`,
    );

    const formattedContext =
      `اطلاعات زنده استخراج‌شده از وب درباره «${cleanQ}»:\n\n` +
      lines.join("\n\n") +
      `\n\nدستورالعمل: بر اساس اطلاعات تازه و زنده وب بالا به کاربر پاسخ دقیق بده. اگر کاربر نرخ لحظه‌ای ارز، طلا یا خبر جدید خواسته، از ارقام و اطلاعات موجود در این گزارش استفاده کن.`;

    const sources = results.map((r) => ({ title: r.title, url: r.url }));

    return {
      ok: true,
      query: cleanQ,
      text: formattedContext,
      sources,
    };
  } catch (err) {
    return { ok: false, query: cleanQ, text: "", sources: [], error: String(err?.message ?? err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
