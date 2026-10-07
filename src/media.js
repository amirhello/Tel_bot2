// Telegram media in, provider-neutral parts out.
//
// Everything here is base64 already, so neither provider module has to know about
// Telegram. Each media type has its own on/off switch, size cap and per-message limit.

import { downloadFile } from "./telegram.js";
import { toBase64 } from "./text.js";

/** Map a Telegram message (or a message it replied to) onto one media slot. */
export function detectMedia(msg) {
  if (!msg) return null;
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { type: "image", id: p.file_id, mime: "image/jpeg", size: p.file_size ?? 0, label: "photo" };
  }
  if (msg.video) {
    return { type: "video", id: msg.video.file_id, mime: msg.video.mime_type || "video/mp4", size: msg.video.file_size ?? 0, label: "video" };
  }
  if (msg.video_note) {
    return { type: "video", id: msg.video_note.file_id, mime: "video/mp4", size: msg.video_note.file_size ?? 0, label: "video note" };
  }
  if (msg.animation) {
    return {
      type: "video",
      id: msg.animation.file_id,
      mime: msg.animation.mime_type || "video/mp4",
      size: msg.animation.file_size ?? 0,
      label: "animation/gif",
    };
  }
  if (msg.document && (msg.document.mime_type ?? "").startsWith("image/")) {
    return {
      type: "image",
      id: msg.document.file_id,
      mime: msg.document.mime_type,
      size: msg.document.file_size ?? 0,
      label: msg.document.file_name || "image file",
    };
  }
  if (msg.voice) {
    return { type: "audio", id: msg.voice.file_id, mime: msg.voice.mime_type || "audio/ogg", size: msg.voice.file_size ?? 0, label: "voice" };
  }
  if (msg.audio) {
    return { type: "audio", id: msg.audio.file_id, mime: msg.audio.mime_type || "audio/mpeg", size: msg.audio.file_size ?? 0, label: "audio" };
  }
  if (msg.sticker) return { type: "sticker", label: "sticker", size: 0 };
  if (msg.document) return { type: "file", id: msg.document.file_id, mime: msg.document.mime_type, size: msg.document.file_size ?? 0, label: msg.document.file_name || "document" };
  return null;
}

/**
 * Collect media from the replied-to message and from the message itself.
 * Anything switched off, oversized or unsupported becomes a readable note instead,
 * so the rest of the message is still answered.
 */
export async function collectMedia(env, msg, cfg) {
  const parts = [];
  const notes = [];
  const used = { image: 0, video: 0, audio: 0 };

  const sources = [
    ["replied", detectMedia(msg.reply_to_message)],
    ["own", detectMedia(msg)],
  ];

  for (const [source, m] of sources) {
    if (!m) continue;

    if (m.type === "sticker") {
      notes.push(`${source} sticker`);
      continue;
    }
    if (m.type === "file") {
      notes.push(`${source} ${m.label} — documents are not supported`);
      continue;
    }

    const rules = cfg.media?.[m.type];
    if (!rules?.enabled) {
      notes.push(`${source} ${m.label} — ${m.type} input is turned off`);
      continue;
    }
    if (used[m.type] >= rules.maxPer) {
      notes.push(`${source} ${m.label} — more than ${rules.maxPer} ${m.type} per message`);
      continue;
    }
    if (m.size > rules.maxMB * 1024 * 1024) {
      notes.push(`${source} ${m.label}, ${(m.size / 1048576).toFixed(1)} MB — over the ${rules.maxMB} MB limit, only this note is sent`);
      continue;
    }

    try {
      const bytes = await downloadFile(env.TELEGRAM_BOT_TOKEN, m.id);
      parts.push({ type: m.type, mime: m.mime, data: toBase64(bytes) });
      used[m.type]++;
    } catch (e) {
      notes.push(`${source} ${m.label} could not be downloaded: ${e.message}`);
    }
  }

  return { media: parts, note: notes.length ? `[${notes.join(" | ")}]` : "" };
}