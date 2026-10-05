// Voice replies through the Gemini Live API — one short-lived session per answer.
//
// answer.js produces the text; this module makes the bot *say* it: open a WebSocket to
// gemini-3.8-live, hand the text over as a single turn, collect raw PCM at 24 kHz and
// wrap it in a WAV header. WAV is deliberate: it is just 44 bytes over raw PCM, so the
// free plan's 10 ms CPU budget survives (an MP3 encoder would not).
//
// The session is one-shot — setup, one turn, close — because the webhook answers
// immediately and only gets one waitUntil window (30 s) to finish the job.

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_MODEL = "gemini-3.8-live";
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
    .replace(/```[\s\S]*?```/g, " ")
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
export async function speak(env, cfg, text) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("live voice: GEMINI_API_KEY is not set");

  const words = spokenText(text);
  if (!words) throw new Error("live voice: nothing to say");

  const model = cfg?.voice?.model || DEFAULT_MODEL;
  const res = await fetch(`${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("live voice: WebSocket upgrade was refused");

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
      liveTimeoutMs,
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

    /**
     * Frames are handled strictly in order, and close/error wait for the queue to drain —
     * otherwise a frame still being decoded would be lost to a fast close, and audio that
     * DID arrive would look like audio that never did.
     */
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

    send({
      setup: {
        model: `models/${model}`,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: { parts: [{ text: SPEAK_PROMPT }] },
      },
    });
  });
}
