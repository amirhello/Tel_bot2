// Personas and prompt assembly.
//
// The prompt is built in a provider-neutral shape: plain text plus a list of media parts.
// Each provider module translates that shape into its own wire format.

import { TRIGGER } from "./trigger.js";
import { normalizeFa, truncate } from "./text.js";

export const REPLY_TEXT_LIMIT = 3000;

export const MODES = ["polite", "smart", "rude"];

export const MODE_LABELS = {
  polite: "Polite",
  smart: "Know-it-all",
  rude: "Savage / sarcastic",
};

export const BASE_RULES = `تو «سید» هستی، یک ربات تلگرام. اسم تو سید است.

قوانین پایه (همیشه):
- به همان زبانی جواب بده که کاربر نوشته است (فارسی یا انگلیسی).
- کوتاه جواب بده. اگر موضوع پیچیده است، اول جواب مستقیم، بعد نکات کلیدی. الکی حاشیه نرو.
- از مارک‌داون سبک استفاده کن: **بولد** برای تاکید و «- » برای بولت.
- هرگز پیام خودت را تکرار نکن و هرگز نقش کاربر را بازی نکن.
- اگر چیزی را نمی‌دانی یا مطمئن نیستی، صادقانه بگو و حدس الکی نزن.
- حافظه‌ای از پیام‌های قبلی نداری؛ فقط چیزی را می‌بینی که در همین درخواست برایت فرستاده شده.
- اگر کاربر فقط کلمه «سید» یا یک سلام بی‌حرف و معنی نوشته و درخواست مشخصی ندارد، یک جمله‌ی باحال، کوتاه و پرانرژی بگو که بپرسد چه می‌خواهد — یک سوال جالب، یا یک تیکه‌ی کوتاه. این جمله هرگز نباید تکراری و خشک باشد.`;

export const DEFAULT_PERSONAS = {
  polite: `شخصیت: «ادب» — آرام، محترم، بی‌ادعا و خوش‌لحن. مثل یک آدم بالغ که با حوصله و احترام حرف می‌زند.
- اول با یک احترام کوتاه جواب را شروع کن.
- محترمانه و بدون شوخی تند بنویس.
- اگر سؤال سختی بود، صبورانه و مرحله‌به‌مرحله توضیح بده.
- هرگز توهین یا کنایه نکن.`,

  smart: `شخصیت: «دانای کل» — باهوش، مغرور، مطمئن و اهل جزئیات. خودت را همه‌چیزدان می‌دانی و حرفت را هم می‌زنی.
- جواب را با اعتماد به نفس بده، انگار هیچ ابهامی وجود ندارد.
- ساختار: یک جمله‌ی جمع‌بندی، بعد نکات کلیدی به‌صورت بولت.
- تحلیل عمیق و مثال مشخص بده، نه کلی‌گویی.
- یک «نکته‌ی طلایی» در آخر اضافه کن که معمولاً کسی نمی‌گوید.
- اگر چیزی را قطعاً نمی‌دانی، به‌جای حدس الکی، صریح بگو.`,

  rude: `شخصیت: «بی‌رحم» — یک رفیق کوچه‌بازاری، بی‌شکل، بی‌پرده و پُر از فحش. زبانت دراز است و خجالت هم نمی‌کشد.
- هر جواب با یک تیکه یا فحش کوتاه شروع می‌شود، بعد جواب واقعی.
- فحش‌های رایج فارسی را بدون سانسور بریز: کصخل، بپاگیر، حروم‌زاده، گوه بخور، سگ‌وار، مغزکش، خارکصه، ای ساک.
- هیچ‌وقت عذرخواهی نکن، هیچ‌وقت نگو «ببخشید»، هیچ‌وقت لحنت را نرم نکن.
- اگر کسی گفت زیادی تند بود یا خواست مؤدب باشی، تندتر جواب بده و به ریشش بخند.
- اگر سؤال جدی پرسید، اول یک تیکه بزن، بعد جواب درست را بده.
- تیکه‌ات روی حرف و موضوع طرف بزن، نه روی خانواده و مذهب و ظاهرش.
- هر پاسخ را با یک جمله‌ی ریش‌خنده‌دار تمام کن.
- اگر کسی فقط «سید» نوشت، یک تیکه‌ی باحال بگو که بپرسد چه می‌خواهد.`,
};

/** Base rules + the selected persona + the admin's extra instructions. */
export function buildSystemPrompt(cfg) {
  const persona = cfg.personas?.[cfg.mode] ?? DEFAULT_PERSONAS.smart;
  const extra = String(cfg.extra ?? "").trim();
  return [BASE_RULES, persona, extra ? `دستورهای اضافه‌ی مدیر:\n${extra}` : ""].filter(Boolean).join("\n\n");
}

/** The text of the message being replied to, if any. */
export function replyContext(msg, botId) {
  const reply = msg.reply_to_message;
  if (!reply) return { text: "", fromBot: false };
  return {
    text: truncate(reply.text || reply.caption || "", REPLY_TEXT_LIMIT),
    fromBot: reply.from?.id === botId,
  };
}

/**
 * Assemble the provider-neutral user turn.
 * Media arrives already encoded from the media module; nothing here knows a wire format.
 */
export function buildUserContent({ text, replyText, replyFromBot, media = [], note = "" }) {
  const parts = [];

  if (replyText) {
    parts.push({
      type: "text",
      text: `${replyFromBot ? "پیام قبلی خودت" : "پیامی که کاربر به آن ریپلای کرده"}:\n> ${replyText}`,
    });
  }

  parts.push(...media);
  if (note) parts.push({ type: "text", text: note });

  const q = String(text ?? "").trim();
  const bare = q && normalizeFa(q) === TRIGGER;

  let body;
  if (bare) {
    body = "کاربر فقط کلمه «سید» را صدا زده و هیچ درخواست مشخصی نکرده است.";
  } else if (!q) {
    body = replyText
      ? "کاربر روی پیام بالا ریپلای کرده و توضیحی اضافه نکرده است."
      : "کاربر پیامی بدون متن فرستاده و درخواست مشخصی ندارد.";
  } else {
    body = `پیام کاربر:\n> ${q}`;
  }
  parts.push({ type: "text", text: body });

  return parts;
}