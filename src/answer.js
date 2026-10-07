// The answering pipeline: webhook update in, Telegram reply out.

import { appendArchive, archiveRecord } from "./archive.js";
import { PoolExhausted, complete } from "./llm.js";
import { collectMedia } from "./media.js";
import { DEFAULT_PERSONAS, buildSystemPrompt, buildUserContent, replyContext } from "./prompt.js";
import { botId, sendAudioFile, sendChatAction, sendLong, sendText } from "./telegram.js";
import { isCommand, isSupportedChat, shouldAnswer } from "./trigger.js";
import { bumpStats, loadConfig, loadStats, usedToday } from "./store.js";
import { speak } from "./voice.js";
const ERRORS = [
  "الان یه کم درگیرم. یه بار دیگه بفرست، شاید سر جا شد.",
  "یه چیزی قاطی شد. دوباره بزن، درستش می‌کنم.",
  "حواسم پرته. یه بار دیگه امتحان کن.",
];

/** 429 means slow down, whoever the provider is. */
const RATE_LIMITED = "سقف درخواست پر شد. چند دقیقه صبر کن و دوباره بفرست.";
const DAILY_LIMIT = "امروز از سقف روزانه‌ام رد شدیم. فردا دوباره در خدمتم.";

// Speaking runs late in the waitUntil window, so cap it well below the 30 s budget:
// the WAV upload afterwards needs a few seconds of its own.
const VOICE_BUDGET_MS = 26_000;

const MODE_NAME = { rude: "Savage", polite: "Polite", smart: "Know-it-all" };

const HELP =
  "سلام، من **سید** هستم.\n\n" +
  "• توی گروه کافیه کلمه **سید** رو توی پیامت بنویسی.\n" +
  "• یا روی هر پیامی ریپلای کنی و بنویسی «سید این چی میگه؟» تا همون پیام رو برات بخونم.\n" +
  "• عکس، ویدیو و ویس هم می‌فهمم، اگر خیلی سنگین نباشه.\n" +
  "• به **ویس نوت**‌ها جواب **صوتی** می‌دهم.\n\n" +
  "I'm __MODE__ mode right now.";

const jobs = new Map();
const capNotified = new Map();

/**
 * "ساعت ۹:۳۰" — the exact moment the daily quota frees up, in Tehran time. Google resets
 * RPD at midnight Pacific: 09:30 Tehran in summer, 08:30 in winter.
 */
function clockTime(resetAt) {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(resetAt));
  } catch {
    return new Date(resetAt).toISOString().slice(11, 16);
  }
}

const exhaustedNotice = (resetAt) =>
  resetAt - Date.now() < 300_000
    ? "در حال حاضر ترافیک و درخواست‌ها به مدل‌های هوش مصنوعی بالاست. لطفاً ۱ دقیقه دیگر دوباره پیام دهید."
    : `امروز از سقف روزانه‌ی همه‌ی مدل‌هام رد شدیم. ساعت ${clockTime(resetAt)} دوباره در خدمتم.`;

/** One answer at a time per chat; anything else queues behind it. */
function serialize(key, job) {
  const prev = jobs.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  const tail = next.catch(() => {});
  jobs.set(key, tail);
  tail.then(() => {
    if (jobs.get(key) === tail) jobs.delete(key);
  });
  return next;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * The one entry point the router calls. Archives every message first — including the ones
 * Sayyad ignores — then answers only what deserves an answer.
 */
export async function processMessage(env, msg) {
  try {
    if (!msg?.from || msg.from.is_bot) return; // never answer bots
    if (!isSupportedChat(msg)) return;

    const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;
    const enabled = config_enabled(cfg);

    let answered = false;
    if (enabled) {
      if (msg.chat?.type === "private") {
        answered = true;
      } else {
        let id = null;
        try {
          id = await botId(env);
        } catch {
          /* getMe failed: ignore, shouldAnswer will still check trigger word */
        }
        answered = shouldAnswer(msg, id, msg.chat?.type);
      }
    }

    if (!enabled || !answered) {
      await appendArchive(env, archiveRecord(msg, false)).catch(() => {});
      return;
    }

    await serialize(msg.chat.id, async () => {
      let outcome = null;
      let replyError = null;
      try {
        outcome = await reply(env, msg, cfg);
      } catch (e) {
        replyError = e;
        const reason = String(e?.message ?? e);
        await bumpStats(env, { errors: 1, lastError: reason.slice(0, 300) });
        // The pool carries the exact hour its quota frees up — far more useful than "later".
        const text =
          e instanceof PoolExhausted
            ? exhaustedNotice(e.resetAt)
            : /\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(reason)
              ? RATE_LIMITED
              : ERRORS[Math.abs(hash(`${msg.chat.id}:${msg.message_id}`)) % ERRORS.length];
        try {
          await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, text, msg.message_id);
        } catch {
          /* nothing more we can do */
        }
      } finally {
        await appendArchive(
          env,
          archiveRecord(msg, {
            answered: true,
            ok: !replyError,
            model: outcome?.model,
            reply: outcome?.text,
            error: replyError ? String(replyError.message ?? replyError) : null,
          }),
        ).catch(() => {});
      }
    });
  } catch (outerErr) {
    console.error("processMessage fatal error:", outerErr);
  }
}

const config_enabled = (cfg) => cfg.enabled !== false;

async function reply(env, msg, cfg) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const cmd = isCommand(text);

  if (cmd === "ping") {
    await sendText(token, chatId, "🏓 pong", msg.message_id);
    return { text: "🏓 pong" };
  }
  if (cmd === "start" || cmd === "help") {
    const helpMsg = HELP.replace("__MODE__", MODE_NAME[cfg.mode] ?? "Know-it-all");
    await sendText(token, chatId, helpMsg, msg.message_id);
    return { text: helpMsg };
  }

  // Checked before the typing indicator and before any model call, so an exhausted day
  // costs no quota and does not look like a hang.
  if (await overDailyCap(env, cfg, msg)) return { text: DAILY_LIMIT };

  await sendChatAction(token, chatId, "typing");
  await bumpStats(env, { requests: 1, lastUsed: new Date().toISOString() });

  const id = msg.reply_to_message ? await botId(env).catch(() => null) : null;
  const { media, note } = await collectMedia(env, msg, cfg);
  const { text: replyText, fromBot } = replyContext(msg, id);

  const { text: answer, model: usedModel } = await complete(env, cfg, {
    system: buildSystemPrompt(cfg),
    parts: buildUserContent({ text, replyText, replyFromBot: fromBot, media, note }),
    maxTokens: cfg.maxTokens,
  });

  // A voice note deserves a voice back: the text answer above becomes a Live API turn
  // and comes back as audio. Anything that goes wrong here is caught by processMessage
  // and reported with one of the friendly ERRORS — never with a silent gap.
  if (voiceReply(msg, cfg)) {
    const startAt = Date.now();
    const elapsed = () => Date.now() - startAt;
    const keep = setInterval(() => sendChatAction(token, chatId, "upload_voice").catch(() => {}), 4000);
    let audioSent = false;
    try {
      if (elapsed() > VOICE_BUDGET_MS) throw new Error("live voice: over the time budget");
      const wav = await speak(env, cfg, answer, { timeoutMs: Math.max(3000, VOICE_BUDGET_MS - elapsed()) });
      await sendAudioFile(token, chatId, wav, "sayyad.wav", "audio/wav", msg.message_id);
      audioSent = true;
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel, voice: true };
    } catch (voiceErr) {
      await bumpStats(env, { errors: 1, lastError: `voice failed: ${voiceErr?.message ?? voiceErr}`.slice(0, 300) });
    } finally {
      clearInterval(keep);
    }
    if (!audioSent) {
      await sendLong(token, chatId, answer, msg.message_id);
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel };
    }
  }

  await sendLong(token, chatId, answer, msg.message_id);
  await bumpStats(env, { replies: 1 });
  return { text: answer, model: usedModel };
}

/** Voice notes are answered with voice — unless either switch (input or voice) is off. */
const voiceReply = (msg, cfg) =>
  !!msg.voice && cfg.media?.audio?.enabled !== false && cfg.voice?.enabled !== false;

/** Refuse politely once the daily budget is gone, and never call the model. */
async function overDailyCap(env, cfg, msg) {
  if (!(cfg.dailyCap > 0)) return false;
  if (usedToday(await loadStats(env)) < cfg.dailyCap) return false;

  const last = capNotified.get(msg.chat.id) ?? 0;
  if (Date.now() - last < 3_600_000) return true;
  capNotified.set(msg.chat.id, Date.now());
  try {
    await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, DAILY_LIMIT, msg.message_id);
  } catch {
    /* the guard still works even if the notice does not get through */
  }
  return true;
}