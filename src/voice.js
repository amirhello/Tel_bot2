// Voice replies through the Gemini Live API — one short-lived session per answer.
//
// answer.js produces the text; this module makes the bot *say* it: open a WebSocket to
// gemini-3.8-live, hand the text over as a single turn, collect raw PCM at 24 kHz and
// wrap it in a WAV header. WAV is deliberate: it is just 44 bytes over raw PCM, so the
// free plan's 10 ms CPU budget survives (an MP3 encoder would not).
//
// The session is one-shot — setup, one turn, close — because the webhook answers
// immediately and only gets one waitUntil window (30 s) to finish the job.

import { complete } from "./llm.js";
import { NodeWebSocket } from "./nodeWs.js";
import { acquireKeyWithWait, extractKeys } from "./keyPool.js";
import { DEFAULT_BASE_URLS } from "./store.js";

const LIVE_ENDPOINT =
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const DEFAULT_MODEL = "gemini-3.8-live";
export const FALLBACK_VOICE_MODELS = [
  "gemini-3.8-live",
  "gemini-2.5-flash-native-audio-dialog",
  "gemini-2.0-flash-exp",
];
const WAV_RATE = 24000; // Live API audio output: PCM 16-bit little-endian, 24 kHz mono
const SPOKEN_MAX = 1500; // ~1.5 min of speech; longer answers would blow the 30 s window
const STALL_MS = 2500; // no new audio for this long ⇒ the turn is over (turnComplete can be very late)

/** The bot speaks with a natural conversational female voice (Aoede). */
const SPEAK_PROMPT =
  "این متن را با صدای زنانه، لحن گرم، مکث‌های تنفسی طبیعی و شبیه به صحبت کردن با یک دوست صمیمی بخوان، نه مثل روخوانی از روی کتاب. " +
  "کلمات را با لهجه گفتاری تهرانی، روان و بدون تکلف بیان کن. مثل یک انسان واقعی حرف بزن و چیزی اضافه یا کم نکن.";

let liveTimeoutMs = 25_000; // whole session, comfortably inside the 30 s waitUntil budget

/** Tests shrink this so a silent session fails fast instead of in 25 s. */
export function setLiveTimeout(ms) {
  liveTimeoutMs = ms;
}

/**
 * Markdown → something a voice can say: no asterisks, no headings, no code fences,
 * links reduced to their label. Written for spoken output, not for rendering.
 */
export function spokenText(text) {
  return String(text ?? "")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[>\-+*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SPOKEN_MAX);
}

/** Raw 16-bit LE mono PCM → WAV. The whole container is 44 bytes of header. */
export function pcmToWav(pcm, rate = WAV_RATE) {
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const ascii = (s, off) => [...s].forEach((c, i) => (header[off + i] = c.charCodeAt(0)));
  ascii("RIFF", 0);
  v.setUint32(4, 36 + pcm.length, true);
  ascii("WAVE", 8);
  ascii("fmt ", 12);
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // format: PCM
  v.setUint16(22, 1, true); // channels: mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii("data", 36);
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(header, 0);
  out.set(pcm, 44);
  return out;
}

/** Frames arrive as string, ArrayBuffer or Blob depending on the runtime — accept all three. */
async function frameText(data) {
  if (typeof data === "string") return data;
  if (typeof data?.arrayBuffer === "function") data = await data.arrayBuffer();
  return new TextDecoder().decode(data);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** base64 → bytes without Buffer (the Worker runtime has no Buffer). */
function base64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
async function connectLiveSocket(key) {
  const wsUrl = LIVE_ENDPOINT.replace(/^http/i, "ws") + `?key=${encodeURIComponent(key)}`;

  if (typeof globalThis.WebSocket === "function") {
    try {
      const ws = new globalThis.WebSocket(wsUrl);
      if (ws) return ws;
    } catch {
      /* fallback */
    }
  }

  // Cloudflare Workers outbound WebSocket (fetch with Upgrade header)
  try {
    const res = await fetch(`${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      headers: { Upgrade: "websocket" },
    });
    if (res?.webSocket) return res.webSocket;
  } catch {
    /* fetch() throws in Node.js on Upgrade header */
  }

  // Node.js fallback: pure built-in https WebSocket client
  if (typeof process !== "undefined" && process?.versions?.node) {
    return new NodeWebSocket(wsUrl);
  }

  throw new Error("live voice: WebSocket upgrade was refused");
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
async function speakOnce(key, model, words, timeoutMs, voiceName = "Aoede") {
  const ws = await connectLiveSocket(key);

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let stallTimer = 0;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      try {
        ws.close(1000, "turn over");
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const hardTimer = setTimeout(
      () => finish(chunks.length ? null : new Error("live voice: timed out"), chunks.length ? pcmToWav(concat(chunks)) : undefined),
      timeoutMs,
    );

    /** The turn is over when the server says so, or when the audio goes quiet. */
    const audioReceived = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => finish(chunks.length ? null : new Error("live voice: no audio came back"), chunks.length ? pcmToWav(concat(chunks)) : undefined),
        STALL_MS,
      );
    };

    const send = (msg) => ws.send(JSON.stringify(msg));

    let queue = Promise.resolve();
    const enqueue = (ev) => {
      queue = queue.then(() => handle(ev)).catch(() => {});
    };

    async function handle(ev) {
      let msg;
      try {
        msg = JSON.parse(await frameText(ev.data));
      } catch {
        return; // keepalive or unknown frame — not worth failing the reply over
      }

      if (msg.error) {
        const detail =
          msg.error.message ??
          (msg.error.status
            ? `${msg.error.status}${msg.error.code ? ` (${msg.error.code})` : ""}`
            : msg.error.code) ??
          JSON.stringify(msg.error);
        return finish(new Error(`live voice: ${detail}`));
      }

      if (msg.setupComplete !== undefined) {
        send({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: words }] }],
            turnComplete: true,
          },
        });
        return;
      }

      for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          chunks.push(base64Bytes(part.inlineData.data));
          audioReceived();
        }
      }

      if (msg.serverContent?.turnComplete || msg.turnComplete) {
        finish(chunks.length ? null : new Error("live voice: turn completed without audio"), chunks.length ? pcmToWav(concat(chunks)) : undefined);
      }
    }

    ws.addEventListener("message", enqueue);
    ws.addEventListener("close", (ev) =>
      queue.then(() => {
        const closeDetail = ev?.reason ? `connection closed: ${ev.reason}` : "connection closed before any audio";
        finish(chunks.length ? null : new Error(`live voice: ${closeDetail}`), chunks.length ? pcmToWav(concat(chunks)) : undefined);
      }),
    );
    ws.addEventListener("error", (ev) =>
      queue.then(() => {
        const errMsg = ev?.message || ev?.error?.message || (typeof ev === "string" ? ev : "connection error");
        finish(chunks.length ? null : new Error(`live voice: ${errMsg}`), chunks.length ? pcmToWav(concat(chunks)) : undefined);
      }),
    );

    if (typeof ws.accept === "function") ws.accept(); // Workers' outbound sockets need this
    try {
      ws.binaryType = "arraybuffer"; // never deal with Blobs
    } catch {
      /* read-only in some runtimes */
    }

    const sendSetup = () => {
      send({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voiceName || "Aoede",
                },
              },
            },
          },
          systemInstruction: { parts: [{ text: SPEAK_PROMPT }] },
        },
      });
    };

    if (ws.readyState === 0) {
      ws.addEventListener("open", sendSetup, { once: true });
    } else {
      sendSetup();
    }
  });
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
export async function speak(env, cfg, text, opts = {}) {
  const rawKeys = extractKeys(env);
  if (!rawKeys.length && !env?.GEMINI_API_KEY) {
    throw new Error("live voice: GEMINI_API_KEY is not set");
  }

  const words = spokenText(text);
  if (!words) throw new Error("live voice: nothing to say");

  const timeoutMs = opts.timeoutMs ?? liveTimeoutMs;
  const startAt = Date.now();
  const primary = cfg?.voice?.model || DEFAULT_MODEL;
  const voiceName = cfg?.voice?.voiceName || "Aoede";
  const pool = [primary, ...FALLBACK_VOICE_MODELS.filter((m) => m !== primary)];

  let lastErr;
  const attempts = [];
  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    const elapsed = Date.now() - startAt;
    const remaining = timeoutMs - elapsed;
    if (i > 0 && remaining < 2000) break;

    const keyHandle = await acquireKeyWithWait(env, { model, maxWaitMs: 1200, pollIntervalMs: 300 });
    const key = keyHandle?.key || env?.GEMINI_API_KEY || rawKeys[0];

    const t0 = Date.now();
    try {
      const wav = await speakOnce(key, model, words, Math.max(1, remaining), voiceName);
      keyHandle?.release();
      attempts.push({ model, ok: true, ms: Date.now() - t0 });
      try {
        opts.onTrace?.({ attempts, chosenModel: model, status: "ok" });
      } catch {}
      return wav;
    } catch (e) {
      const clean = String(e?.message ?? e).replace(/key=[^&\s]+/gi, "key=[REDACTED]");
      lastErr = new Error(clean);
      keyHandle?.release(lastErr);
      attempts.push({ model, ok: false, error: clean.slice(0, 150), ms: Date.now() - t0 });
      try {
        opts.onTrace?.({ attempts, lastError: clean.slice(0, 150), status: "failed" });
      } catch {}
      if (!/(?:model|not found|unknown|404|unsupported|unavailable|closed|backend exploded|connection|disconnect|refused|failed|timeout|timedout|hang up|reset|econnreset|etimedout|500|502|503|504|server error|no audio|without audio|429|quota|resource_exhausted|rate.?limit)/i.test(clean)) {
        throw lastErr;
      }
    }
  }

  throw lastErr ?? new Error("live voice: all voice models failed");
}

/**
 * Prompt for Gemma 4 to classify both search and voice intents in a single call.
 */
export const INTENT_SYSTEM_PROMPT =
  "شما یک سیستم طبقه‌بندی هوشمند نیت پیام برای ربات تلگرام هستید.\n" +
  "وظیفه شما تحلیل پیام ورودی کاربر و تعیین دو فیلد بولین (\"search\" و \"voice\") در قالب یک خروجی JSON است.\n\n" +
  "قوانین تشخیص:\n" +
  "۱. فیلد \"search\":\n" +
  "- true: اگر پاسخ به پیام کاربر نیازمند اطلاعات لحظه‌ای و زنده باشد (مثل نرخ دلار، طلا، ارز، رمزارز، قیمت اجناس، وضعیت آب‌وهوا، اخبار روز، نتایج مسابقات ورزشی، رخدادهای تازه) یا کاربر صریحاً خواسته باشد مطلبی در اینترنت سرچ/گوگل شود.\n" +
  "- false: برای سوالات عمومی، برنامه‌نویسی، شعر، احوال‌پرسی، ترجمه، تاریخ و مسائلی که نیازی به وب‌سرچ زنده ندارند.\n\n" +
  "۲. فیلد \"voice\":\n" +
  "- true: اگر کاربر خواسته باشد پاسخ به صورت صوتی، ویس یا با صدا فرستاده شود یا متن برایش خوانده شود (چه صریح بگوید «ویس بده»، «با صدا بگو» و چه عامیانه مثل «برام بخون»، «حوصله خوندن ندارم»، «صداتو بشنوم»).\n" +
  "- false: اگر پیام متنی عادی باشد یا کاربر خواسته باشد متنی بنویسی.\n\n" +
  "قالب خروجی:\n" +
  "پاسخ شما فقط و فقط باید یک شیء JSON معتبر، بدون هیچ کلمه، توضیح اضافه یا بلاک متنی باشد.\n" +
  "دقیقاً در این قالب:\n" +
  "{\"search\": false, \"voice\": false}";

/**
 * Safely parse JSON intent output from Gemma 4.
 */
export function parseIntentJson(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { search: false, voice: false };
  }
  const clean = rawText.trim();
  if (/^YES$/i.test(clean)) {
    return { search: false, voice: true };
  }
  if (/^NO$/i.test(clean)) {
    return { search: false, voice: false };
  }
  const unquoted = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(unquoted);
    return {
      search: Boolean(parsed.search),
      voice: Boolean(parsed.voice),
    };
  } catch {
    const searchMatch = /"search"\s*:\s*(true|false)/i.exec(clean);
    const voiceMatch = /"voice"\s*:\s*(true|false)/i.exec(clean);
    return {
      search: searchMatch ? searchMatch[1].toLowerCase() === "true" : false,
      voice: voiceMatch ? voiceMatch[1].toLowerCase() === "true" : false,
    };
  }
}

/**
 * Detect both search and voice intents via a single Gemma 4 classifier call.
 */
export async function detectIntent(env, text, cfg, traceContext = null) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { search: false, voice: false };
  }

  const clean = text.trim();
  try {
    const classifierCfg = {
      ...cfg,
      provider: {
        ...cfg?.provider,
        kind: "gemini",
        baseUrl: cfg?.provider?.kind === "gemini" && cfg?.provider?.baseUrl ? cfg.provider.baseUrl : DEFAULT_BASE_URLS.gemini,
        model: "gemma-4-31b",
        modelPool: ["gemma-4-31b", "gemma-4-26b"],
      },
      maxTokens: 50,
      thinking: "off",
    };

    const res = await complete(env, classifierCfg, {
      system: INTENT_SYSTEM_PROMPT,
      parts: [{ type: "text", text: clean }],
    });

    const parsed = parseIntentJson(res?.text);
    if (traceContext) {
      traceContext.intent = {
        requested: parsed.voice,
        method: "gemma_classifier",
        model: res?.model || "gemma-4-31b",
        output: String(res?.text || "").trim().slice(0, 50),
      };
      traceContext.search = {
        requested: parsed.search,
        reason: parsed.search ? "gemma_classifier" : "standard prompt",
      };
    }
    return parsed;
  } catch (err) {
    if (traceContext) {
      traceContext.intent = {
        requested: false,
        method: "gemma_classifier_error",
        error: String(err?.message ?? err).slice(0, 100),
      };
    }
    return { search: false, voice: false };
  }
}

/** Backward compatibility wrapper for voice-only callers. */
export async function detectVoiceIntent(env, text, cfg, traceContext = null) {
  if (cfg?.voice?.enabled === false) {
    if (traceContext) traceContext.intent = { requested: false, reason: "voice disabled in config" };
    return false;
  }
  const res = await detectIntent(env, text, cfg, traceContext);
  return res.voice;
}

/**
 * Determines whether a message should be answered with voice:
 * 1. If incoming message is an audio/voice note.
 * 2. If incoming text asks for a voice response (intent detected via Gemma).
 */
export async function shouldVoiceReply(env, msg, cfg, text, traceContext = null) {
  if (cfg?.voice?.enabled === false) {
    if (traceContext) traceContext.intent = { requested: false, reason: "voice disabled in config" };
    return false;
  }
  if (msg?.voice && cfg?.media?.audio?.enabled !== false) {
    if (traceContext) traceContext.intent = { requested: true, method: "incoming_voice", reason: "user sent voice note" };
    return true;
  }
  if (text) {
    return await detectVoiceIntent(env, text, cfg, traceContext);
  }
  return false;
}
