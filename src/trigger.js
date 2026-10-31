// Decides when the bot speaks, and recognises its commands.

import { normalizeFa } from "./text.js";

export const TRIGGER = "سید";

const CHAT_TYPES = new Set(["private", "group", "supergroup"]);

export function isSupportedChat(msg) {
  return Boolean(msg?.chat) && CHAT_TYPES.has(msg.chat.type);
}

export function isCommand(text, myBotUsername) {
  const m = /^\/(start|help|ping|search|google|find|جستجو|سرچ)(?:@(\S+))?(?:\s|$)/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const targetBot = m[2];
  if (targetBot && myBotUsername) {
    const cleanTarget = targetBot.toLowerCase().replace(/^@/, "");
    const cleanMine = myBotUsername.toLowerCase().replace(/^@/, "");
    if (cleanTarget !== cleanMine) {
      return null;
    }
  }
  return m[1].toLowerCase();
}

/** Groups: only when the wake word appears, or when Sayyad itself is replied to. */
export function shouldAnswer(msg, botId, chatType, myBotUsername) {
  if (chatType === "private") return true;
  const text = normalizeFa(msg.text || msg.caption || "");
  if (isCommand(text, myBotUsername)) return true;
  if (/(?<![\p{L}])سید(?![\p{L}])/u.test(text)) return true;
  if (msg.reply_to_message?.from?.id === botId) return true;
  return false;
}