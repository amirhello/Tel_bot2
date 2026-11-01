// The answering pipeline: webhook update in, Telegram reply out.

import { appendArchive, archiveRecord } from "./archive.js";
import { PoolExhausted, complete } from "./llm.js";
import { collectMedia } from "./media.js";
import { DEFAULT_PERSONAS, MODES, MODE_LABELS, buildSystemPrompt, buildUserContent, replyContext } from "./prompt.js";
import {
  botId,
  botUsername,
  sendAudioFile,
  sendChatAction,
  sendLong,
  sendRichMessage,
  sendText,
  sendInlineKeyboard,
  answerCallbackQuery,
  editMessageText,
} from "./telegram.js";
import { isCommand, isSupportedChat, shouldAnswer } from "./trigger.js";
import { esc, hasRichFormatting, isRtlText, mdToRichHtml, splitRichHtml } from "./text.js";
import { bumpStats, loadConfig, loadStats, usedToday } from "./store.js";
import { detectIntent, shouldVoiceReply, speak } from "./voice.js";
import { extractSearchQuery, searchWeb } from "./search.js";
import { isUserBlocked, recordUserActivity, setUserMode } from "./users.js";
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

const MODE_NAME = {
  psychologist: "Psychologist",
  friend: "Best Friend",
  smart: "Know-it-all",
  rude: "Savage",
  wolf: "Market Strategist",
  polite: "Polite",
};

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

/** One answer at a time per chat, bounded so an earlier slow request cannot starve waitUntil. */
export function serialize(key, job) {
  const prev = jobs.get(key) ?? Promise.resolve();
  let timerId;
  const waitPrev = Promise.race([
    prev.catch(() => {}),
    new Promise((r) => { timerId = setTimeout(r, 12_000); }),
  ]).finally(() => clearTimeout(timerId));
  const next = waitPrev.then(job);
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
  const startedAt = Date.now();
  try {
    if (!msg?.from || msg.from.is_bot) return; // never answer bots
    if (!isSupportedChat(msg)) return;

    // Record user activity for admin management
    await recordUserActivity(env, msg.from, msg.chat).catch(() => {});

    // Check if user is blocked by admin
    if (await isUserBlocked(env, msg.from.id)) {
      await appendArchive(env, archiveRecord(msg, { answered: false, reason: "user blocked by admin" })).catch(() => {});
      return;
    }

    const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;
    const enabled = config_enabled(cfg);

    let answered = false;
    if (enabled) {
      if (msg.chat?.type === "private") {
        answered = true;
      } else {
        let id = null;
        let myBotUsername = null;
        try {
          id = await botId(env);
          myBotUsername = await botUsername(env);
        } catch {
          /* getMe failed: ignore, shouldAnswer will still check trigger word */
        }
        answered = shouldAnswer(msg, id, msg.chat?.type, myBotUsername);
      }
    }

    if (!enabled || !answered) {
      const ignoreReason = !enabled
        ? "bot disabled in admin panel"
        : "group message without wake word (سید) or reply to bot";
      await appendArchive(env, archiveRecord(msg, { answered: false, reason: ignoreReason })).catch(() => {});
      return;
    }

    await serialize(msg.chat.id, async () => {
      let outcome = null;
      let replyError = null;
      let tgOut = null;
      const trace = { intent: null, llm: null, voice: null, delivery: null };
      try {
        outcome = await reply(env, msg, cfg, trace);
        tgOut = outcome?.tgOut ?? "delivered";
      } catch (e) {
        replyError = e;
        if (e.trace && trace.llm) {
          trace.llm.attempts = e.trace;
        }
        const reason = String(e?.message ?? e);
        await bumpStats(env, { errors: 1, lastError: reason.slice(0, 300) });
        const text =
          e instanceof PoolExhausted
            ? exhaustedNotice(e.resetAt)
            : /\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(reason)
              ? RATE_LIMITED
              : ERRORS[Math.abs(hash(`${msg.chat.id}:${msg.message_id}`)) % ERRORS.length];
        try {
          await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, text, msg.message_id, msg.message_thread_id);
          tgOut = "error notice delivered to user";
        } catch (sendErr) {
          tgOut = `failed to send error notice: ${String(sendErr?.message ?? sendErr).slice(0, 120)}`;
        }
      } finally {
        const fullTrace = outcome?.trace || trace;
        logPipelineTrace(msg, outcome, replyError, fullTrace);

        await appendArchive(
          env,
          archiveRecord(msg, {
            answered: true,
            ok: !replyError,
            model: outcome?.model,
            reply: outcome?.text,
            error: replyError ? String(replyError.message ?? replyError) : null,
            rawError: formatRawError(replyError, fullTrace),
            ms: Date.now() - startedAt,
            reason: outcome?.reason,
            voice: outcome?.voice,
            voiceError: outcome?.voiceError,
            tgOut,
            trace: fullTrace,
          }),
        ).catch(() => {});
      }
    });
  } catch (outerErr) {
    console.error("processMessage fatal error:", outerErr);
  }
}

export function formatRawError(err, trace) {
  if (!err) return null;
  const lines = [];
  lines.push(`Message: ${err.message || String(err)}`);
  if (err.name) lines.push(`Type: ${err.name}`);
  if (err.status !== undefined) lines.push(`HTTP Status: ${err.status}`);
  if (err.code) lines.push(`Code: ${err.code}`);
  const failedModel = err.model || trace?.llm?.chosenModel || trace?.llm?.attempts?.at(-1)?.model;
  if (failedModel) lines.push(`Target Model: ${failedModel}`);
  const failedKey = err.keyIndex !== undefined ? err.keyIndex : trace?.llm?.attempts?.at(-1)?.keyIndex;
  if (failedKey !== undefined) lines.push(`Key Index: Key #${failedKey + 1}`);
  if (err.url) lines.push(`URL: ${err.url}`);

  if (trace?.llm?.attempts?.length) {
    lines.push(`\n[LLM Attempts History]`);
    for (const a of trace.llm.attempts) {
      const keyPart = a.keyIndex !== undefined ? ` Key #${a.keyIndex + 1}` : "";
      const msPart = a.ms !== undefined ? ` in ${a.ms}ms` : "";
      const errPart = a.error ? ` (${a.error})` : "";
      lines.push(`• ${a.model}${keyPart} -> ${a.status}${msPart}${errPart}`);
    }
  }

  if (err.details) {
    lines.push(`\n[Raw Details / Payload]`);
    try {
      lines.push(typeof err.details === "object" ? JSON.stringify(err.details, null, 2) : String(err.details));
    } catch {
      lines.push(String(err.details));
    }
  }

  if (err.stack) {
    lines.push(`\n[Stack Trace]`);
    lines.push(err.stack);
  }

  return lines.join("\n");
}

function logPipelineTrace(msg, outcome, replyError, trace) {
  const user = msg.from?.first_name || msg.from?.username || msg.from?.id || "user";
  const textSnippet = (msg.text || msg.caption || "").replace(/\s+/g, " ").slice(0, 50);
  console.log(`\n[Trace] 📨 Message from ${user} (Chat ${msg.chat?.id}): "${textSnippet}"`);
  if (trace?.intent) {
    const isV = trace.intent.requested ? "🎙️ Voice YES" : "💬 Voice NO";
    console.log(`  ├─ Intent: ${isV} [${trace.intent.method || "default"}] ${trace.intent.reason || ""}`);
  }
  if (trace?.search) {
    const isS = trace.search.requested ? "🔍 Search YES" : "🔎 Search NO";
    const srcCount = trace.search.sources?.length ? ` (${trace.search.sources.length} sources)` : "";
    console.log(`  ├─ Search: ${isS}${srcCount} [${trace.search.reason || "auto"}]`);
  }
  if (trace?.llm?.attempts?.length) {
    console.log(`  ├─ LLM Routing:`);
    for (const a of trace.llm.attempts) {
      const icon = a.status === "ok" ? "✅" : "⚠️";
      const keyStr = a.keyIndex !== undefined ? ` Key #${a.keyIndex + 1}` : "";
      const msStr = a.ms !== undefined ? ` in ${a.ms}ms` : "";
      const errStr = a.error ? ` (${a.error.slice(0, 60)})` : "";
      console.log(`  │   ${icon} ${a.model}${keyStr} -> ${a.status}${msStr}${errStr}`);
    }
  }
  if (outcome?.model) {
    console.log(`  ├─ Selected Model: ${outcome.model}`);
  }
  if (trace?.voice) {
    const vIcon = trace.voice.status === "delivered" ? "✅" : "❌";
    console.log(`  ├─ Voice TTS: ${vIcon} ${trace.voice.status} ${trace.voice.chosenModel ? `[${trace.voice.chosenModel}]` : ""}`);
    if (trace.voice.attempts?.length) {
      for (const va of trace.voice.attempts) {
        console.log(`  │   ${va.ok ? "✅" : "❌"} ${va.model} -> ${va.ok ? "OK" : va.error} (${va.ms}ms)`);
      }
    }
  }
  if (replyError) {
    console.log(`  └─ ❌ Error: ${replyError.message || replyError}`);
    console.log(`     ┌─ 🔍 Raw Error Info:`);
    if (replyError.name) console.log(`     │  Type: ${replyError.name}`);
    if (replyError.status !== undefined) console.log(`     │  HTTP Status: ${replyError.status}`);
    if (replyError.code) console.log(`     │  Code: ${replyError.code}`);
    const failedModel = replyError.model || trace?.llm?.chosenModel || trace?.llm?.attempts?.at(-1)?.model;
    if (failedModel) console.log(`     │  Model: ${failedModel}`);
    const failedKey = replyError.keyIndex !== undefined ? replyError.keyIndex : trace?.llm?.attempts?.at(-1)?.keyIndex;
    if (failedKey !== undefined) console.log(`     │  Key: Key #${failedKey + 1}`);
    if (replyError.url) console.log(`     │  URL: ${replyError.url}`);
    if (replyError.details) {
      const dStr = typeof replyError.details === "object" ? JSON.stringify(replyError.details) : String(replyError.details);
      console.log(`     │  Raw Payload: ${dStr.slice(0, 300)}`);
    }
    if (replyError.stack) {
      const firstStack = replyError.stack.split("\n")[1]?.trim();
      if (firstStack) console.log(`     │  Location: ${firstStack}`);
    }
    console.log(`     └────────────────────────`);
  } else {
    console.log(`  └─ 📤 Telegram Out: ${outcome?.tgOut || "delivered"}`);
  }
}

/** Append web source citations from search grounding to the reply. */
export function appendSources(text, sources) {
  if (!Array.isArray(sources) || !sources.length) return text;
  const base = String(text ?? "").trim();
  const count = sources.length;
  const faCount = String(count).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);

  const items = sources.map((s) => {
    const title = esc(s.title || "منبع وب");
    const url = s.url || "#";
    let domain = "";
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {}
    const domainBadge = domain ? ` <i>(${domain})</i>` : "";
    return `• <a href="${url}">${title}</a>${domainBadge}`;
  });

  const sourcesBlock = [
    `<details><summary>🌐 منابع معتبر جستجو (${faCount})</summary>`,
    items.join("\n"),
    `</details>`,
  ].join("\n");

  return `${base}\n\n${sourcesBlock}`;
}

/**
 * Deliver text reply to Telegram, attempting Bot API 10.3 rich_message
 * if text contains tables or rich tags, with graceful fallback to sendLong.
 */
export async function deliverTextReply(token, chatId, text, replyTo, opts = {}) {
  const threadId = opts.message_thread_id ?? opts.threadId;
  const model = opts.model;

  if (hasRichFormatting(text)) {
    try {
      const isRtl = isRtlText(text);
      const richHtml = mdToRichHtml(text);
      const chunks = splitRichHtml(richHtml, 3400);
      let allDelivered = true;
      for (const chunk of chunks) {
        const res = await sendRichMessage(token, chatId, chunk, replyTo, isRtl, threadId);
        if (!res?.ok) {
          allDelivered = false;
          break;
        }
      }
      if (allDelivered && chunks.length > 0) {
        const desc = chunks.length > 1
          ? `rich message delivered in ${chunks.length} parts (Bot API 10.3)`
          : "rich message delivered (Bot API 10.3)";
        return { kind: "rich_message", tgOut: desc };
      }
    } catch {
      // Degrade gracefully to sendLong
    }
  }

  await sendLong(token, chatId, text, replyTo, { model, message_thread_id: threadId });
  return { kind: "text", tgOut: "text delivered" };
}

const config_enabled = (cfg) => cfg.enabled !== false;

async function reply(env, msg, cfg, trace = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const text = msg.text || msg.caption || "";
  const myName = await botUsername(env).catch(() => null);
  const cmd = isCommand(text, myName);

  if (cmd === "ping") {
    await sendText(token, chatId, "🏓 pong", msg.message_id, threadId);
    return { text: "🏓 pong", reason: "command /ping", tgOut: "text delivered" };
  }
  if (cmd === "mode" || cmd === "شخصیت") {
    const keyboard = [
      [
        { text: "🧠 روانشناس", callback_data: "mode:psychologist" },
        { text: "🤝 رفیق فاب", callback_data: "mode:friend" },
      ],
      [
        { text: "👑 دانای کل", callback_data: "mode:smart" },
        { text: "⚡ بی‌رحم", callback_data: "mode:rude" },
      ],
      [
        { text: "🐺 گرگ بازار", callback_data: "mode:wolf" },
        { text: "📖 ادیب", callback_data: "mode:polite" },
      ],
    ];
    const modePrompt = "🎭 **انتخاب شخصیت سید:**\nیکی از شخصیت‌های زیر را انتخاب کن تا از این به بعد با همان لحن باهات هم‌کلام شوم:";
    await sendInlineKeyboard(token, chatId, modePrompt, keyboard, msg.message_id, threadId);
    return { text: modePrompt, reason: `command /${cmd}`, tgOut: "inline keyboard delivered" };
  }
  if (cmd === "start" || cmd === "help") {
    let currentMode = cfg.mode;
    if (msg.from?.id && env.CONFIG) {
      const uMode = await env.CONFIG.get(`user:${msg.from.id}:mode`).catch(() => null);
      if (uMode && MODES.includes(uMode)) currentMode = uMode;
    }
    const helpMsg = HELP.replace("__MODE__", MODE_NAME[currentMode] ?? "Know-it-all");
    await sendText(token, chatId, helpMsg, msg.message_id, threadId);
    return { text: helpMsg, reason: `command /${cmd}`, tgOut: "text delivered" };
  }

  // Checked before the typing indicator and before any model call, so an exhausted day
  // costs no quota and does not look like a hang.
  if (await overDailyCap(env, cfg, msg)) {
    return { text: DAILY_LIMIT, reason: "daily cap reached", tgOut: "daily cap guard" };
  }

  let isVoice = Boolean(msg?.voice && cfg?.media?.audio?.enabled !== false && cfg?.voice?.enabled !== false);
  let isSearch = false;

  if (text) {
    const intent = await detectIntent(env, text, cfg, trace);
    if (!isVoice && cfg?.voice?.enabled !== false) {
      isVoice = Boolean(intent.voice);
    }
    isSearch = Boolean(intent.search);
  } else if (isVoice) {
    if (trace) trace.intent = { requested: true, method: "incoming_voice", reason: "user sent voice note" };
  }

  const actionKind = isVoice ? "upload_voice" : "typing";

  await sendChatAction(token, chatId, actionKind, threadId).catch(() => {});
  await bumpStats(env, { requests: 1, lastUsed: new Date().toISOString() });

  const typingHeartbeat = setInterval(() => {
    sendChatAction(token, chatId, actionKind, threadId).catch(() => {});
  }, 4000);

  let answer, usedModel;
  trace.llm = { attempts: [], chosenModel: null };
  try {
    const id = msg.reply_to_message ? await botId(env).catch(() => null) : null;
    const { media, note } = await collectMedia(env, msg, cfg);
    const { text: replyText, fromBot } = replyContext(msg, id);

    let searchNote = "";
    let searchSources = [];
    if (isSearch) {
      const q = extractSearchQuery(text);
      try {
        const searchRes = await searchWeb(q, { timeoutMs: 4000 });
        if (searchRes?.text) {
          searchNote = searchRes.text;
          searchSources = searchRes.sources || [];
          if (trace?.search) {
            trace.search.query = q;
            trace.search.sources = searchSources;
          }
        }
      } catch (searchErr) {
        if (trace?.search) {
          trace.search.error = String(searchErr?.message ?? searchErr).slice(0, 100);
        }
      }
    }

    const effectiveNote = note ? (searchNote ? `${note}\n\n${searchNote}` : note) : searchNote;

    let effectiveCfg = cfg;
    if (msg.from?.id && env.CONFIG) {
      const uMode = await env.CONFIG.get(`user:${msg.from.id}:mode`).catch(() => null);
      if (uMode && MODES.includes(uMode)) {
        effectiveCfg = { ...cfg, mode: uMode };
      }
    }

    const res = await complete(env, effectiveCfg, {
      system: buildSystemPrompt(effectiveCfg, { isVoice }),
      parts: buildUserContent({ text, replyText, replyFromBot: fromBot, media, note: effectiveNote }),
      maxTokens: cfg.maxTokens,
      search: false,
    });
    answer = res.text;
    usedModel = res.model;
    if (res.trace) trace.llm.attempts = res.trace;
    trace.llm.chosenModel = usedModel;

    const allSources = [...searchSources, ...(res.sources || [])];
    if (allSources.length) {
      if (trace?.search) trace.search.sources = allSources;
      answer = appendSources(answer, allSources);
    }
  } finally {
    clearInterval(typingHeartbeat);
  }

  // A voice note (or text requesting voice) deserves a voice back: the text answer above
  // becomes a Live API turn and comes back as audio.
  if (isVoice) {
    trace.voice = { attempts: [], status: "pending" };
    const startAt = Date.now();
    const elapsed = () => Date.now() - startAt;
    const keep = setInterval(() => sendChatAction(token, chatId, "upload_voice", threadId).catch(() => {}), 4000);
    let audioSent = false;
    let vErrText = null;
    try {
      if (elapsed() > VOICE_BUDGET_MS) throw new Error("live voice: over the time budget");
      const wav = await speak(env, cfg, answer, {
        timeoutMs: Math.max(3000, VOICE_BUDGET_MS - elapsed()),
        onTrace: (t) => {
          trace.voice.attempts = t.attempts || [];
          if (t.chosenModel) trace.voice.chosenModel = t.chosenModel;
        },
      });
      await sendAudioFile(token, chatId, wav, "sayyad.wav", "audio/wav", msg.message_id, threadId);
      audioSent = true;
      trace.voice.status = "delivered";
      trace.delivery = { kind: "voice", filename: "sayyad.wav" };
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel, voice: true, tgOut: "audio delivered (sayyad.wav)", trace };
    } catch (voiceErr) {
      vErrText = `voice failed: ${voiceErr?.message ?? voiceErr}`.slice(0, 300);
      trace.voice.status = "failed";
      trace.voice.error = vErrText;
      await bumpStats(env, { errors: 1, lastError: vErrText });
    } finally {
      clearInterval(keep);
    }
    if (!audioSent) {
      const deliveryRes = await deliverTextReply(token, chatId, answer, msg.message_id, {
        model: usedModel,
        message_thread_id: threadId,
      });
      trace.delivery = { kind: "text_fallback", reason: vErrText };
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel, voice: false, voiceError: vErrText, tgOut: deliveryRes.tgOut, trace };
    }
  }

  const deliveryRes = await deliverTextReply(token, chatId, answer, msg.message_id, {
    model: usedModel,
    message_thread_id: threadId,
  });
  trace.delivery = { kind: deliveryRes.kind };
  await bumpStats(env, { replies: 1 });
  return { text: answer, model: usedModel, tgOut: deliveryRes.tgOut, trace };
}

/** Voice notes are answered with voice — unless either switch (input or voice) is off. */
export const voiceReply = (msg, cfg) =>
  !!msg?.voice && cfg?.media?.audio?.enabled !== false && cfg?.voice?.enabled !== false;

/** Refuse politely once the daily budget is gone, and never call the model. */
async function overDailyCap(env, cfg, msg) {
  if (!(cfg.dailyCap > 0)) return false;
  if (usedToday(await loadStats(env)) < cfg.dailyCap) return false;

  const last = capNotified.get(msg.chat.id) ?? 0;
  if (Date.now() - last < 60_000) return true;
  capNotified.set(msg.chat.id, Date.now());
  if (capNotified.size > 1000) {
    const now = Date.now();
    for (const [k, v] of capNotified) {
      if (now - v >= 60_000) capNotified.delete(k);
    }
  }
  try {
    await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, DAILY_LIMIT, msg.message_id, msg.message_thread_id);
  } catch {
    /* the guard still works even if the notice does not get through */
  }
  return true;
}

const CONFIRM_TEXTS = {
  psychologist: "🧠 **شخصیت من برات شد «روانشناس»**\nهر دغدغه، حس یا گره فکری داری راحت بگو؛ با حوصله و بدون قضاوت می‌شنوم.",
  friend: "🤝 **شخصیت من برات شد «رفیق فاب»**\nحله داداش، از الان به بعد پایه‌تم، مشتی و خودمونی بریم جلو!",
  smart: "👑 **شخصیت من برات شد «دانای کل»**\nخیلی خوش اومدی؛ آماده‌ی پاسخ‌های کاریزماتیک، عمیق و نکته‌های طلایی باش.",
  rude: "⚡ **شخصیت من برات شد «بی‌رحم و سارکاستیک»**\nخودت خواستی! آماده‌ی تیکه‌های تیز، حقایق تلخ و شوخی‌های گزنده باش.",
  wolf: "🐺 **شخصیت من برات شد «گرگ بازار»**\nعالیه؛ وقت و پول سرمایه‌ست، بهانه‌ها رو بریز دور و متمرکز شو روی نتیجه و برد.",
  polite: "📖 **شخصیت من برات شد «ادیب»**\nبسی مایه مسرت است؛ با کمال احترام و کلامی پیراسته در خدمت شما هستم.",
};

/** Handle incoming Telegram callback queries (e.g. inline button clicks). */
export async function processCallback(env, callbackQuery) {
  if (!callbackQuery?.id) return;
  const token = env.TELEGRAM_BOT_TOKEN;
  const queryId = callbackQuery.id;
  const from = callbackQuery.from;
  const data = String(callbackQuery.data || "");
  const message = callbackQuery.message;

  if (data.startsWith("mode:")) {
    const chosenMode = data.slice(5);
    if (MODES.includes(chosenMode) && from?.id) {
      await setUserMode(env, from.id, chosenMode);
      await answerCallbackQuery(token, queryId, "شخصیت شما با موفقیت تغییر کرد ✅").catch(() => {});
      if (message?.chat?.id && message?.message_id) {
        const confirmText = CONFIRM_TEXTS[chosenMode] || "شخصیت شما با موفقیت تنظیم شد.";
        await editMessageText(token, message.chat.id, message.message_id, confirmText).catch(() => {});
      }
      return;
    }
  }
  await answerCallbackQuery(token, queryId).catch(() => {});
}