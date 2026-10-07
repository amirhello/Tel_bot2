// The admin's own copy of everything Telegram delivered. Never sent to the model.

export const ARCHIVE_KEY = "log:v1";
export const ARCHIVE_LIMIT = 200;

/** Build one record. Media is described, never stored. */
export function archiveRecord(msg, outcome) {
  const isObj = typeof outcome === "object" && outcome !== null;
  const answered = isObj ? outcome.answered : !!outcome;
  const r = {
    t: msg.date ? msg.date * 1000 : Date.now(),
    u: {
      id: msg.from?.id,
      name: msg.from?.first_name || msg.from?.last_name || msg.from?.username || String(msg.from?.id ?? ""),
    },
    c: { id: msg.chat?.id, t: msg.chat?.title || msg.chat?.type },
    m: msg.message_id,
    x: msg.text || msg.caption || "",
    k: mediaKind(msg),
    a: answered,
  };
  if (isObj) {
    if (outcome.ok !== undefined) r.ok = outcome.ok;
    if (outcome.model) r.model = outcome.model;
    if (outcome.reply) r.reply = String(outcome.reply).slice(0, 4000);
    if (outcome.error) r.err = String(outcome.error).slice(0, 1000);
  }
  return r;
}

/** A short label for the media on a message, without touching any bytes. */
export function mediaKind(msg) {
  const kinds = [];
  if (msg.photo?.length) kinds.push("photo");
  if (msg.video) kinds.push("video");
  if (msg.video_note) kinds.push("video note");
  if (msg.animation) kinds.push("animation");
  if (msg.document) kinds.push("document");
  if (msg.voice) kinds.push("voice");
  if (msg.audio) kinds.push("audio");
  if (msg.sticker) kinds.push("sticker");
  return kinds.length ? kinds.join(", ") : "text only";
}

export async function readArchive(env) {
  try {
    if (!env?.CONFIG) return [];
    const raw = await env.CONFIG.get(ARCHIVE_KEY, "json");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Prepend a record and drop the oldest past the limit. Never throws. */
export async function appendArchive(env, record) {
  try {
    if (!env?.CONFIG) return;
    const items = await readArchive(env);
    items.unshift(record);
    await env.CONFIG.put(ARCHIVE_KEY, JSON.stringify(items.slice(0, ARCHIVE_LIMIT)));
  } catch {
    /* the free KV tier runs out of writes; the archive is optional, the bot is not */
  }
}