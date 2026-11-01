import { isRtlText, mdToHtml, mdToRichHtml, splitText } from "./text.js";

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/** Call any Bot API method. Throws only on transport errors; Telegram errors come back as ok:false. */
export async function tg(token, method, payload) {
  const res = await fetch(api(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // If Telegram returned 429 Too Many Requests, respect retry_after
    if (res.status === 429 && data?.parameters?.retry_after && method !== "getUpdates") {
      const waitSec = Math.min(10, data.parameters.retry_after);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      const retryRes = await fetch(api(token, method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      return retryRes.json().catch(() => data);
    }
  }
  return data ?? { ok: false, error: "invalid_json" };
}

export const getMe = (token) => tg(token, "getMe");

let botIdCache = null;
let botUsernameCache = null;

/** The bot's own id, fetched once per isolate. Telegram asks for it on every answer. */
export async function botId(env) {
  if (botIdCache) return botIdCache;
  const me = await getMe(env.TELEGRAM_BOT_TOKEN);
  if (!me?.ok) throw new Error(`getMe failed: ${me?.description ?? "unknown"}`);
  botIdCache = me.result.id;
  botUsernameCache = me.result.username;
  return botIdCache;
}

export async function botUsername(env) {
  if (botUsernameCache) return botUsernameCache;
  const me = await getMe(env.TELEGRAM_BOT_TOKEN);
  if (!me?.ok) return null;
  botIdCache = me.result.id;
  botUsernameCache = me.result.username;
  return botUsernameCache;
}

export const setWebhook = (token, url, secretToken) =>
  tg(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
    max_connections: 10,
  });

export const deleteWebhook = (token) => tg(token, "deleteWebhook", { drop_pending_updates: false });
export const getWebhookInfo = (token) => tg(token, "getWebhookInfo");
const lastChatAction = new Map();

export const sendChatAction = (token, chatId, action = "typing", threadId) => {
  const tid = typeof threadId === "object" ? (threadId?.message_thread_id ?? threadId?.threadId) : threadId;
  const key = `${chatId}:${tid || 0}:${action}`;
  const now = Date.now();
  const last = lastChatAction.get(key) || 0;
  // If sent within last 3.5 seconds for the same chat, skip to prevent 429 flood
  if (now - last < 3500) {
    return Promise.resolve({ ok: true, result: true, skipped: true });
  }
  lastChatAction.set(key, now);
  if (lastChatAction.size > 500) {
    for (const [k, v] of lastChatAction) {
      if (now - v > 30_000) lastChatAction.delete(k);
    }
  }
  const payload = { chat_id: chatId, action };
  if (tid) payload.message_thread_id = tid;
  return tg(token, "sendChatAction", payload);
};

/**
 * Send a rich message (Bot API 10.3+) supporting native tables, expandable quotes,
 * buttons and native RTL. Returns telegram API response or null.
 */
export async function sendRichMessage(token, chatId, html, replyTo, isRtl = true, threadIdOrOpts) {
  const base = { chat_id: chatId };
  const tid = typeof threadIdOrOpts === "object"
    ? (threadIdOrOpts?.message_thread_id ?? threadIdOrOpts?.threadId)
    : threadIdOrOpts;
  if (tid) base.message_thread_id = tid;
  if (replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const payload = {
    ...base,
    rich_message: { html, is_rtl: Boolean(isRtl) },
  };

  try {
    const res = await tg(token, "sendRichMessage", payload);
    if (res?.ok) return res;
    // Retry once on transient network or 5xx server errors
    if (!res || res.error_code >= 500 || res.error === "invalid_json") {
      await new Promise((r) => setTimeout(r, 1200));
      return await tg(token, "sendRichMessage", payload);
    }
    return res;
  } catch {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      return await tg(token, "sendRichMessage", payload);
    } catch {
      return null;
    }
  }
}

/** Send a message, trying HTML first and degrading to plain text if Telegram objects. */
export async function sendText(token, chatId, text, replyTo, threadIdOrOpts) {
  const base = { chat_id: chatId };
  const tid = typeof threadIdOrOpts === "object"
    ? (threadIdOrOpts?.message_thread_id ?? threadIdOrOpts?.threadId)
    : threadIdOrOpts;
  if (tid) base.message_thread_id = tid;
  // reply_parameters, not reply_to_message_id: a deleted target never costs us the message.
  if (replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const first = await tg(token, "sendMessage", { ...base, text: mdToHtml(text), parse_mode: "HTML" });
  if (first?.ok) return first;

  const retry = await tg(token, "sendMessage", { ...base, text });
  if (!retry?.ok) throw new Error(`sendMessage failed: ${retry?.description ?? "unknown"}`);
  return retry;
}

/**
 * Send a long answer using standard Telegram sendMessage (HTML parse_mode).
 */
export async function sendLong(token, chatId, text, replyTo, opts = {}) {
  const options = typeof opts === "object" && opts !== null ? opts : { message_thread_id: opts };
  const tid = options.message_thread_id ?? options.threadId;
  const chunks = splitText(text, 3200);

  for (const chunk of chunks) {
    const rendered = mdToHtml(chunk).length;
    if (rendered <= 3900) {
      await sendText(token, chatId, chunk, replyTo, tid);
      continue;
    }
    const narrower = Math.max(600, Math.floor((chunk.length * 3800) / rendered));
    for (const sub of splitText(chunk, narrower)) {
      await sendText(token, chatId, sub, replyTo, tid);
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

/**
 * Send an audio file so it plays in the chat. WAV is not a format every client likes for
 * `sendAudio`, so a refusal falls back to `sendDocument` — the user still gets the sound.
 */
export async function sendAudioFile(token, chatId, bytes, fileName, mime, replyTo, threadIdOrOpts) {
  const blob = () => new Blob([bytes], { type: mime });
  const tid = typeof threadIdOrOpts === "object"
    ? (threadIdOrOpts?.message_thread_id ?? threadIdOrOpts?.threadId)
    : threadIdOrOpts;

  const post = (method, field) => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (tid) form.append("message_thread_id", String(tid));
    if (replyTo) form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    form.append(field, blob(), fileName);
    return fetch(api(token, method), { method: "POST", body: form })
      .then((r) => r.json())
      .catch(() => null);
  };

  const first = await post("sendAudio", "audio");
  if (first?.ok) return first;

  const second = await post("sendDocument", "document");
  if (second?.ok) return second;

  throw new Error(`sendAudio failed: ${first?.description ?? second?.description ?? "unknown"}`);
}

/** Send message with inline keyboard markup. */
export function sendInlineKeyboard(token, chatId, text, inlineKeyboard, replyTo, threadIdOrOpts) {
  const tid = typeof threadIdOrOpts === "object"
    ? (threadIdOrOpts?.message_thread_id ?? threadIdOrOpts?.threadId)
    : threadIdOrOpts;
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard },
  };
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  if (tid) payload.message_thread_id = tid;
  return tg(token, "sendMessage", payload);
}

/** Answer incoming callback query from inline button tap. */
export function answerCallbackQuery(token, callbackQueryId, text, showAlert = false) {
  const payload = {
    callback_query_id: callbackQueryId,
    show_alert: Boolean(showAlert),
  };
  if (text) payload.text = text;
  return tg(token, "answerCallbackQuery", payload);
}

/** Edit existing message text and optional reply markup. */
export function editMessageText(token, chatId, messageId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tg(token, "editMessageText", payload);
}