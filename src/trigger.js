// Decides when the bot speaks, and recognises its commands.

import { normalizeFa } from "text";

export const TRIGGER = "سید";

const CHAT_TYPES = new Set(["private", "group", "supergroup"]);

export function isSupportedChat(msg) {
  return Boolean(msg?.chat) && CHAT_TYPES.has(msg.chat.type);
}

export function isCommand(text) {
  const m = /^\/(start|help|ping)(@\S+)?/i.exec(String(text ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/** Groups: only when the wake word appears, or when Sayyad itself is replied to. */
export function shouldAnswer(msg, botId, chatType) {
  if (chatType === "private") return true;
  const text = normalizeFa(msg.text || msg.caption || "");
  if (text.includes(TRIGGER)) return true;
  if (msg.reply_to_message?.from?.id === botId) return true;
  return false;
}