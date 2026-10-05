// Telegram Bot API client and the outbound half of a reply.

import { mdToHtml, splitText } from "text";

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/** Call any Bot API method. Throws only on transport errors; Telegram errors come back as ok:false. */
export async function tg(token, method, payload) {
  const res = await fetch(api(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return res.json();
}

export const getMe = (token) => tg(token, "getMe");

let botIdCache = null;

/** The bot's own id, fetched once per isolate. Telegram asks for it on every answer. */
export async function botId(env) {
  if (botIdCache) return botIdCache;
  const me = await getMe(env.TELEGRAM_BOT_TOKEN);
  if (!me?.ok) throw new Error(`getMe failed: ${me?.description ?? "unknown"}`);
  botIdCache = me.result.id;
  return botIdCache;
}

export const setWebhook = (token, url, secretToken) =>
  tg(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: true,
    max_connections: 10,
  });

export const deleteWebhook = (token) => tg(token, "deleteWebhook", { drop_pending_updates: false });
export const getWebhookInfo = (token) => tg(token, "getWebhookInfo");
export const sendChatAction = (token, chatId, action = "typing") => tg(token, "sendChatAction", { chat_id: chatId, action });

/** Send a message, trying HTML first and degrading to plain text if Telegram objects. */
export async function sendText(token, chatId, text, replyTo) {
  const base = { chat_id: chatId };
  // reply_parameters, not reply_to_message_id: a deleted target never costs us the message.
  if (replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const first = await tg(token, "sendMessage", { ...base, text: mdToHtml(text), parse_mode: "HTML" });
  if (first?.ok) return first;

  const retry = await tg(token, "sendMessage", { ...base, text });
  if (!retry?.ok) throw new Error(`sendMessage failed: ${retry?.description ?? "unknown"}`);
  return retry;
}

/**
 * Send a long answer. The split is measured on the *rendered* HTML, because markdown grows
 * once it becomes tags — otherwise a bold-heavy answer silently blows past the 4096 limit.
 */
export async function sendLong(token, chatId, text, replyTo) {
  for (const chunk of splitText(text, 3200)) {
    const rendered = mdToHtml(chunk).length;
    if (rendered <= 3900) {
      await sendText(token, chatId, chunk, replyTo);
      continue;
    }
    const narrower = Math.max(600, Math.floor((chunk.length * 3800) / rendered));
    for (const sub of splitText(chunk, narrower)) {
      await sendText(token, chatId, sub, replyTo);
    }
  }
}

/** Download a Telegram file. Returns raw bytes; the caller decides how to encode them. */
export async function downloadFile(token, fileId) {
  const info = await tg(token, "getFile", { file_id: fileId });
  if (!info?.ok || !info.result?.file_path) throw new Error("getFile failed");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
  if (!res.ok) throw new Error("file download failed");
  return new Uint8Array(await res.arrayBuffer());
}