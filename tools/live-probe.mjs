// Faz-0 probe: talk to the Gemini Live API directly, outside the Worker.
//
// Proves the protocol (model id, setup, text turn in, audio turn out, WAV assembly)
// and lets a human judge the Persian voice before any bot code is written.
//
//   $env:GEMINI_API_KEY='...'   # PowerShell — never commit the key
//   node tools/live-probe.mjs
//
// Optional:  node tools/live-probe.mjs "your own prompt"
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("GEMINI_API_KEY is not set.");
  process.exit(1);
}

const MODEL = "models/gemini-3.8-live";
const WSS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const PROMPT =
  process.argv[2] ??
  "سلام سید! چند کلمه به فارسی روان بگو تا کیفیت صدات را بسنجم. لحن دوستانه باشد.";

const SYSTEM =
  "تو «سید» هستی، یک دستیار فارسی‌زبان شوخ و صمیمی. فقط و فقط فارسی حرف بزن. " +
  "جواب‌هایت کوتاه و گفتاری باشد (مثل حرف زدن، نه نوشتن).";

const ws = new WebSocket(`${WSS}?key=${KEY}`);
ws.binaryType = "arraybuffer"; // binary frames arrive as ArrayBuffer, never Blob
const audioChunks = []; // base64 PCM24 pieces
let transcript = "";
const seen = new Set();
const t0 = Date.now();
let setupDone = false;

const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// 16-bit little-endian PCM → 24 kHz mono WAV
function toWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const timeout = setTimeout(() => {
  log("TIMEOUT after 45s — closing");
  try { ws.close(); } catch {}
}, 45_000);

ws.addEventListener("open", () => {
  log("ws open — sending setup", MODEL);
  ws.send(
    JSON.stringify({
      setup: {
        model: MODEL,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: { parts: [{ text: SYSTEM }] },
        outputAudioTranscription: {},
      },
    }),
  );
});

ws.addEventListener("message", async (ev) => {
  let msg;
  try {
    let data = ev.data;
    if (typeof data !== "string") {
      if (typeof data?.arrayBuffer === "function") data = await data.arrayBuffer(); // Blob
      data = new TextDecoder().decode(data);
    }
    msg = JSON.parse(data);
  } catch {
    const d = ev.data;
    const peek =
      typeof d === "string"
        ? d.slice(0, 160)
        : `<${d?.size ?? d?.byteLength ?? "?"} bytes> ` +
          new TextDecoder().decode(
            new Uint8Array(
              typeof d?.arrayBuffer === "function" ? await d.arrayBuffer() : (d ?? new ArrayBuffer(0)),
            ).slice(0, 80),
          );
    log("unparsable frame:", peek);
    return;
  }
  const type = Object.keys(msg)[0] ?? Object.keys(msg).join(",");
  if (!seen.has(type)) { seen.add(type); log("first message of type:", type); }

  if (msg.setupComplete !== undefined && !setupDone) {
    setupDone = true;
    log("setupComplete — sending text turn");
    ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text: PROMPT }] }], turnComplete: true },
      }),
    );
    return;
  }

  const parts = msg.serverContent?.modelTurn?.parts ?? [];
  for (const p of parts) {
    if (p.inlineData?.data) audioChunks.push(Buffer.from(p.inlineData.data, "base64"));
    if (p.text) log("model text part:", p.text.slice(0, 120));
  }
  if (msg.outputTranscription?.text) transcript += msg.outputTranscription.text;

  if (msg.serverContent?.turnComplete) {
    clearTimeout(timeout);
    const pcm = Buffer.concat(audioChunks);
    const out = join(tmpdir(), "sayyad-live-probe.wav");
    writeFileSync(out, toWav(pcm));
    log("turnComplete ✔");
    console.log("---- results ----");
    console.log("audio bytes   :", pcm.length, `(~${(pcm.length / 48000).toFixed(1)}s at 24kHz/16bit)`);
    console.log("transcription :", transcript || "(none — outputAudioTranscription unsupported?)");
    console.log("message types :", [...seen].join(", "));
    console.log("wav written   :", out);
    console.log("wall time     :", ((Date.now() - t0) / 1000).toFixed(1) + "s");
    try { ws.close(); } catch {}
    process.exit(0);
  }

  if (msg.error) {
    clearTimeout(timeout);
    console.error("server error:", JSON.stringify(msg.error));
    process.exit(1);
  }
});

ws.addEventListener("error", (e) => {
  clearTimeout(timeout);
  console.error("ws error:", e.message ?? e);
  process.exit(1);
});

ws.addEventListener("close", (e) => {
  clearTimeout(timeout);
  if (!setupDone) console.error("closed before setup:", e.code, e.reason);
  process.exit(audioChunks.length ? 0 : 1);
});
