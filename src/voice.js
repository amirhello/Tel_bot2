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

/** The bot speaks as Sayyad; it must add nothing to the text it was handed. */
const SPEAK_PROMPT =
  "تو «سید» هستی. این متن، جواب خودت است؛ فقط و فقط همان را با صدای فارسی روان، گفتاری و صمیمی بخوان. " +
  "مثل آدم حرف بزن، نه مثل خواندن متن. چیزی اضافه یا کم نکن.";

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
async function speakOnce(key, model, words, timeoutMs) {
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
        const detail = msg.error.message ?? msg.error.status ?? JSON.stringify(msg.error);
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
    ws.addEventListener("close", () => queue.then(() => finish(chunks.length ? null : new Error("live voice: connection closed before any audio"), chunks.length ? pcmToWav(concat(chunks)) : undefined)));
    ws.addEventListener("error", () => queue.then(() => finish(chunks.length ? null : new Error("live voice: connection error"), chunks.length ? pcmToWav(concat(chunks)) : undefined)));

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
          generationConfig: { responseModalities: ["AUDIO"] },
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
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("live voice: GEMINI_API_KEY is not set");

  const words = spokenText(text);
  if (!words) throw new Error("live voice: nothing to say");

  const timeoutMs = opts.timeoutMs ?? liveTimeoutMs;
  const startAt = Date.now();
  const primary = cfg?.voice?.model || DEFAULT_MODEL;
  const pool = [primary, ...FALLBACK_VOICE_MODELS.filter((m) => m !== primary)];

  let lastErr;
  const attempts = [];
  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    const elapsed = Date.now() - startAt;
    const remaining = timeoutMs - elapsed;
    if (i > 0 && remaining < 2000) break;

    const t0 = Date.now();
    try {
      const wav = await speakOnce(key, model, words, Math.max(1, remaining));
      attempts.push({ model, ok: true, ms: Date.now() - t0 });
      opts.onTrace?.({ attempts, chosenModel: model, status: "ok" });
      return wav;
    } catch (e) {
      const clean = String(e?.message ?? e).replace(/key=[^&\s]+/gi, "key=[REDACTED]");
      lastErr = new Error(clean);
      attempts.push({ model, ok: false, error: clean.slice(0, 150), ms: Date.now() - t0 });
      opts.onTrace?.({ attempts, lastError: clean.slice(0, 150), status: "failed" });
      if (!/model|not found|unknown|404|unsupported|unavailable|closed before any audio|backend exploded|connection error|refused|failed|timeout/i.test(clean)) {
        throw lastErr;
      }
    }
  }

  throw lastErr ?? new Error("live voice: all voice models failed");
}

/**
 * Fast regex for detecting explicit negative intent (user definitely does NOT want audio).
 */
const VOICE_NEGATIVE_RE =
  /(?:ویس|صدا|صوتی|voice)\s*(?:نفرست|نده|نگو|نمیخوام|نباشه|نکن|نزن)|(?:متنی|تکست|نوشتاری)\s*(?:بگو|بفرست|بنویس|جواب بده)/iu;

/**
 * Fast regex for detecting explicit positive voice requests without waiting for LLM.
 */
const VOICE_POSITIVE_RE =
  /(?:ویس|صدا|صوتی|voice).*(?:بفرست|بده|بگو|بخون|توضیح|تعریف|ضبط)|(?:با|به صورت|به شکل)\s*(?:ویس|صدا|صوتی)|(?:برام|برامون)\s*بخون/iu;

/**
 * Quick hint check: If the message contains none of these words, it's definitely not voice-related.
 * Saves an LLM call for 99% of normal messages.
 */
const VOICE_HINT_RE =
  /(?:ویس|صدا|صوتی|بخون|بشنو|گوش|تعریف|بلند|رادیو|voice|audio|speak|listen)/iu;

/**
 * Prompt for Gemma 4 to classify colloquial/indirect voice requests.
 */
const INTENT_SYSTEM_PROMPT =
  "وظیفه شما فقط و فقط تشخیص این است که آیا کاربر در متن پیام، درخواست پاسخ صوتی یا ویس کرده است یا خیر.\n" +
  "اگر کاربر حتی به صورت غیرمستقیم (مثلاً: «حوصله خوندن ندارم برام تعریف کن»، «تو ماشینم بگو بشنوم»، «بلند بگو») خواسته پاسخ به شکل صدا/ویس باشد، فقط بنویس: YES\n" +
  "اگر پیام یک متن معمولی است یا کاربر گفته ویس نفرست، فقط بنویس: NO\n" +
  "هیچ توضیح اضافه‌ای نده. پاسخ فقط یک کلمه باشد: YES یا NO";

/**
 * Detect if user message is asking for a voice reply.
 * Uses fast regex for clear cases, and Gemma 4 for colloquial/nuanced Persian requests.
 */
export async function detectVoiceIntent(env, text, cfg, traceContext = null) {
  if (cfg?.voice?.enabled === false) {
    if (traceContext) traceContext.intent = { requested: false, reason: "voice disabled in config" };
    return false;
  }
  if (!text || typeof text !== "string") return false;
  const clean = text.trim();
  if (!clean) return false;

  // 1. If text has no hint of voice/audio words at all, skip immediately without LLM call
  if (!VOICE_HINT_RE.test(clean)) {
    if (traceContext) traceContext.intent = { requested: false, method: "fast_hint_filter", reason: "no voice keywords in text" };
    return false;
  }

  // 2. Fast negative check
  if (VOICE_NEGATIVE_RE.test(clean)) {
    if (traceContext) traceContext.intent = { requested: false, method: "fast_regex_negative", reason: "explicit negative request" };
    return false;
  }

  // 3. Fast positive check
  if (VOICE_POSITIVE_RE.test(clean)) {
    if (traceContext) traceContext.intent = { requested: true, method: "fast_regex_positive", reason: "keyword matched: " + clean.slice(0, 40) };
    return true;
  }

  // 4. Nuanced / colloquial check via Gemma 4
  try {
    const classifierCfg = {
      ...cfg,
      provider: {
        ...cfg?.provider,
        kind: "gemini",
        model: "gemma-4-31b",
        modelPool: ["gemma-4-31b", "gemma-4-26b"],
      },
      maxTokens: 5,
      thinking: "off",
    };

    const res = await complete(env, classifierCfg, {
      system: INTENT_SYSTEM_PROMPT,
      parts: [{ type: "text", text: clean }],
    });

    const out = String(res?.text || "").trim().toUpperCase();
    const isYes = out.includes("YES");
    if (traceContext) {
      traceContext.intent = {
        requested: isYes,
        method: "gemma_classifier",
        model: res?.model || "gemma-4-31b",
        output: out.slice(0, 30),
      };
    }
    return isYes;
  } catch (err) {
    if (traceContext) {
      traceContext.intent = {
        requested: false,
        method: "gemma_classifier_error",
        error: String(err?.message ?? err).slice(0, 100),
      };
    }
    return false;
  }
}

/**
 * Determines whether a message should be answered with voice:
 * 1. If incoming message is an audio/voice note.
 * 2. If incoming text asks for a voice response (intent detected).
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

