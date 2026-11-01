// Pure text helpers. No I/O, no bindings, no imports.

/** Escape text for Telegram HTML parse_mode. */
export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert the limited markdown a model emits (**bold**, *italic*, `code`, ```block```)
 * into Telegram HTML. Code is lifted out first so it is escaped exactly once.
 */
export function mdToHtml(md) {
  const slots = [];
  const keep = (rendered) => {
    slots.push(rendered);
    return `\u0000S${slots.length - 1}\u0000`;
  };

  let s = String(md ?? "");

  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) =>
    keep(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${esc(code)}</code>`));

  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w\\])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w\\])_([^_\n]+)_/g, "$1<i>$2</i>");
  s = s.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1 ($2)");
  s = s.replace(/\u0000S(\d+)\u0000/g, (_m, i) => slots[Number(i)]);

  return s.trim();
}

/** Split a long reply into Telegram-sized chunks, preferring line then word boundaries. */
export function splitText(text, limit = 3900) {
  const out = [];
  let rest = String(text ?? "").trim();
  if (!rest) return [""];

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.3) cut = limit;

    // Check if cut point falls between a UTF-16 surrogate pair (High surrogate 0xD800-0xDBFF)
    if (cut > 0) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cut--;
      }
    }
    if (cut <= 0) {
      cut = (rest.charCodeAt(0) >= 0xd800 && rest.charCodeAt(0) <= 0xdbff && rest.length >= 2) ? 2 : 1;
    }

    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  out.push(rest);
  return out.filter((p) => p.length);
}

/**
 * Normalise Persian/Arabic so the trigger word matches however it was typed:
 * ي -> ی, ك -> ک, drop tashkeel and tatweel, strip ZWNJ.
 */
export function normalizeFa(s) {
  return String(s ?? "")
    .replace(/[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[\u0649\u064A]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u06AA\u06AB]/g, "\u06A9")
    .replace(/[\u200C\u200E\u200F]/g, " ");
}

export function isRtlText(s) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(String(s ?? ""));
}

/** Check if text contains structured markdown tables or Telegram 10.3 rich tags. */
export function hasRichFormatting(text) {
  const s = String(text ?? "");
  if (/(?:^|\n)\s*\|[^\n]+\|\r?\n\s*\|[\s\-:|]+\|\r?\n\s*\|[^\n]+\|/.test(s)) return true;
  if (/<(\/)?(table|details|tg-button|tg-button-row|blockquote|footer|figure|img|h[1-6])/i.test(s)) return true;
  return false;
}

const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link"]);

/**
 * Automatically balances and closes unclosed HTML tags to prevent Telegram 400 Bad Request.
 */
export function balanceHtmlTags(html) {
  let s = String(html ?? "");
  if (!s) return "";

  // 1. Strip incomplete trailing tag if cut off mid-tag, e.g. "...<table" or "...<tg-bu"
  s = s.replace(/<[a-zA-Z0-9_-]*[^>]*$/, "");

  // 2. Scan tags using regex
  const tagRegex = /<(\/)?([a-zA-Z0-9_-]+)([^>]*)>/g;
  const stack = [];
  let match;

  while ((match = tagRegex.exec(s)) !== null) {
    const isClosing = Boolean(match[1]);
    const tagName = match[2].toLowerCase();
    const tagBody = match[3] || "";

    // Skip void tags or explicitly self-closing tags (e.g. <img />, <br/>)
    if (VOID_TAGS.has(tagName) || tagBody.trim().endsWith("/")) {
      continue;
    }

    if (isClosing) {
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) {
        stack.splice(idx);
      }
    } else {
      stack.push(tagName);
    }
  }

  // 3. Close remaining unclosed tags in reverse order
  while (stack.length > 0) {
    const tag = stack.pop();
    s += `</${tag}>`;
  }

  return s;
}

/**
 * Splits a long rich HTML document into balanced, valid sub-documents
 * under maxLen (default 3400 chars) preserving block structures.
 */
export function splitRichHtml(html, maxLen = 3400) {
  let s = String(html ?? "").trim();
  if (!s || s.length <= maxLen) return [s];

  const chunks = [];
  while (s.length > maxLen) {
    const window = s.slice(0, maxLen);
    let splitIdx = -1;

    const blockEnds = [
      "</details>",
      "</table>",
      "</blockquote>",
      "</figure>",
      "</tg-button-row>",
      "</h3>",
      "</p>",
      "\n\n",
    ];

    for (const b of blockEnds) {
      const idx = window.lastIndexOf(b);
      if (idx !== -1 && idx >= maxLen * 0.35) {
        splitIdx = idx + b.length;
        break;
      }
    }

    if (splitIdx === -1) {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx !== -1 && lineIdx >= maxLen * 0.35) {
        splitIdx = lineIdx + 1;
      } else {
        const spaceIdx = window.lastIndexOf(" ");
        splitIdx = spaceIdx !== -1 && spaceIdx >= maxLen * 0.35 ? spaceIdx + 1 : maxLen;
      }
    }

    const chunk = s.slice(0, splitIdx);
    chunks.push(balanceHtmlTags(chunk));
    s = s.slice(splitIdx).trim();
  }

  if (s.length > 0) {
    chunks.push(balanceHtmlTags(s));
  }

  return chunks;
}

/**
 * Converts markdown tables (| h1 | h2 |\n|---|---|\n| d1 | d2 |)
 * to Telegram native <table bordered striped> (Bot API 10.3+).
 */
export function renderMarkdownTables(text) {
  return text.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n)(?:\|[\s\-:|]+\|\r?\n)(?:\|[^\n]+\|\r?\n?)+)/g, (_m, tableBlock) => {
    const lines = tableBlock.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return tableBlock;

    const parseCells = (line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => esc(c.trim()));

    const headers = parseCells(lines[0]);
    const rows = lines.slice(2).map(parseCells);

    const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody>`;

    return `\n<table bordered striped>${thead}${tbody}</table>\n`;
  });
}

/**
 * Converts markdown blockquotes (> quote) to Telegram <blockquote expandable>.
 */
export function renderBlockquotes(text) {
  return text.replace(/(?:^|\n)((?:>[^\n]*\r?\n?)+)/g, (_m, block) => {
    const content = block
      .split(/\r?\n/)
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    if (!content) return "";
    return `\n<blockquote expandable>${esc(content)}</blockquote>\n`;
  });
}

/**
 * Converts markdown to Telegram Rich Message HTML (Bot API 10.3+).
 * Supports <table bordered striped>, <blockquote expandable>, <details><summary>,
 * <tg-button>, <footer>, <h3>, with guaranteed closed tags.
 */
export function mdToRichHtml(md, opts = {}) {
  let s = String(md ?? "").trim();
  if (!s) return "";

  const slots = [];
  const keep = (rendered) => {
    slots.push(rendered);
    return `\u0000S${slots.length - 1}\u0000`;
  };

  // 1. Preserve pre/code blocks
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) =>
    keep(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${esc(code)}</code>`));

  // 2. Render markdown tables
  s = s.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n)(?:\|[\s\-:|]+\|\r?\n)(?:\|[^\n]+\|\r?\n?)+)/g, (match) =>
    keep(renderMarkdownTables(match)));

  // 3. Render blockquotes as expandable
  s = s.replace(/(?:^|\n)((?:>[^\n]*\r?\n?)+)/g, (match) =>
    keep(renderBlockquotes(match)));

  // 4. Preserve native rich tags if already emitted by model or template (both paired or individual tokens)
  s = s.replace(/<\/?(tg-button-row|tg-button|table|thead|tbody|tfoot|tr|th|td|details|summary|blockquote|figure|figcaption|footer|h[1-6]|p|b|i|u|s|code|pre|a)[^>]*>/gi, (tag) => keep(tag));
  s = s.replace(/<img[^>]*>/gi, (tag) => keep(tag));

  // 5. Convert headers ### Header to <h3>Header</h3>
  s = s.replace(/^#{1,4}\s+(.+)$/gm, (_m, h) => keep(`<h3>${esc(h)}</h3>`));

  // 6. Escape general text
  s = esc(s);

  // 7. Inline styling
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w\\])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w\\])_([^_\n]+)_/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2">$1</a>');

  // 8. Restore preserved slots
  s = s.replace(/\u0000S(\d+)\u0000/g, (_m, i) => slots[Number(i)]);

  // 9. Append footer if provided
  if (opts.footer) {
    s += `\n<footer>${esc(opts.footer)}</footer>`;
  }

  // 10. Auto-balance tags so Telegram Bot API 10.3 never rejects truncated or unclosed HTML
  return balanceHtmlTags(s.trim());
}

/** Base64-encode bytes in chunks, so a multi-megabyte buffer cannot blow the stack. */
export function toBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** A one-line preview for collapsed list rows. */
export function preview(s, n = 90) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}