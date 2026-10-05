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

/** Base64-encode bytes in chunks, so a multi-megabyte buffer cannot blow the stack. */
export function toBase64(bytes) {
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