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

/**
 * Detects whether the user is asking for real-time information or web search.
 * Triggers on commands, explicit search phrasing, and live topics (rates, weather, news, sports).
 */
export function detectSearchIntent(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return false;

  // 1. Explicit search commands
  if (/^\/(search|google|find|جستجو|سرچ)(?:@\S+)?(?:\s|$)/i.test(raw)) return true;

  const text = normalizeFa(raw);

  // 2. Explicit search requests in natural language
  const explicitSearch = /(?:سرچ|جستجو|گوگل|توی\s*گوگل|تو\s*گوگل|توی\s*نت|تو\s*نت|برام\s*سرچ|آنلاین\s*بگرد|چک\s*کن)\s*(?:کن|بزن|کنید|کنی|بگرد)?/i;
  if (explicitSearch.test(text)) return true;

  // 3. Live financial, weather, news & sports topics
  const liveTopics = [
    /(?:قیمت|نرخ|ارزش)\s*(?:لحظه\s*ای|امروز|الان)?\s*(?:دلار|تتر|طلا|سکه|ارز|یورو|درهم|بیت\s*کوین|اتریوم|بورس|خودرو|پراید|آیفون)/i,
    /(?:دلار|تتر|بیت\s*کوین|سکه\s*امامی|طلا|اتریوم)\s*(?:چنده|چند\s*شد|چند\s*است|قیمتش\s*چنده)/i,
    /(?:آخرین\s*اخبار|اخبار\s*امروز|خبر\s*جدید|امروز\s*چه\s*خبر|سرخط\s*اخبار|خبرهای\s*جدید)/i,
    /(?:وضعیت\s*هوا|آب\s*و\s*هوا|هواشناسی|دمای\s*هوا|پیش\s*بینی\s*هوا)/i,
    /(?:نتیجه\s*بازی|جدول\s*لیگ|خلاصه\s*بازی|بازی\s*دیشب)/i,
  ];
  if (liveTopics.some((re) => re.test(text))) return true;

  return false;
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