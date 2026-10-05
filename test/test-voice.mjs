import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";

const worker = M.default;
const { signWebhookSecret, spokenText, pcmToWav, setLiveTimeout, speak } = M;

/* ---------------------------------------------------------------- fakes */

const PCM = new Uint8Array(9600).fill(7); // 0.2 s of silence — enough to prove the plumbing
const PCM_B64 = Buffer.from(PCM).toString("base64");

let tg = [];

/** A scripted WebSocket: the script reacts to whatever speak() sends. */
function fakeSocket(script) {
  const listeners = { message: [], close: [], error: [] };
  const sock = {
    sent: [],
    accepted: false,
    closed: false,
    accept() {
      sock.accepted = true;
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    send(data) {
      sock.sent.push(JSON.parse(data));
      script?.(sock, JSON.parse(data));
    },
    close() {
      sock.closed = true;
    },
    emit(type, data) {
      for (const fn of listeners[type]) fn({ data });
    },
    emitClose() {
      for (const fn of listeners.close) fn({});
    },
  };
  return sock;
}

/** setup → setupComplete, then audio frames → turnComplete. */
const happyScript = (sock, msg) => {
  if (msg.setup) {
    sock.emit("message", JSON.stringify({ setupComplete: {} }));
  } else if (msg.clientContent) {
    sock.emit("message", JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: PCM_B64 } }] } } }));
    sock.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
  }
};

let lastSock = null;
let modelReply = "**جواب** صوتی [با لینک](https://x) و `کد`";

function installFetch(script = happyScript, opts = {}) {
  lastSock = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);

    if (u.includes("BidiGenerateContent")) {
      if (opts.refuseUpgrade) return json({ ok: false });
      lastSock = fakeSocket(script);
      return { webSocket: lastSock };
    }

    if (u.endsWith("/getMe")) return json({ ok: true, result: { id: 777, username: "sayyad_bot" } });
    if (u.endsWith("/getFile")) return json({ ok: true, result: { file_path: "media/f.bin" } });
    if (u.includes("/sendAudio")) {
      const file = init.body.get("audio");
      tg.push({ method: "sendAudio", name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      return json({ ok: true, result: { message_id: 9 } });
    }
    if (u.includes("/sendDocument")) {
      tg.push({ method: "sendDocument" });
      return json({ ok: true, result: { message_id: 10 } });
    }
    if (u.includes("/sendMessage")) {
      tg.push({ method: "sendMessage", body: JSON.parse(init.body) });
      return json({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("/sendChatAction")) {
      tg.push({ method: "sendChatAction", body: JSON.parse(init.body) });
      return json({ ok: true, result: true });
    }
    if (u.includes("/file/bot")) return new Response(new Uint8Array(64).fill(3), { status: 200 });
    if (u.includes("generativelanguage")) {
      return json({ candidates: [{ content: { parts: [{ text: modelReply }] } }], usageMetadata: { totalTokenCount: 12 } });
    }
    return json({ choices: [{ message: { content: modelReply } }] });
  };
}

function setup(script) {
  tg = [];
  modelReply = "**جواب** صوتی [با لینک](https://x) و `کد`";
  installFetch(script);
}

const sentMessages = () => tg.filter((c) => c.method === "sendMessage");
const stats = (e) => JSON.parse(e.CONFIG.store["stats:v2"] ?? "{}");

/* ---------------------------------------------------------------- helpers */

let updateId = 5000;

async function push(message, override) {
  const pending = [];
  const res = await worker.fetch(
    new Request("https://x.dev/", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": await signWebhookSecret(override.ADMIN_PASSWORD) },
      body: JSON.stringify({ update_id: updateId++, message }),
    }),
    override,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}

const voiceNote = (over = {}) => ({
  message_id: 21,
  date: 1700000000,
  chat: { id: 42, type: "private" },
  from: { id: 42, is_bot: false, first_name: "رضا" },
  voice: { file_id: "v1", file_size: 40_000, mime_type: "audio/ogg" },
  ...over,
});

/* ---------------------------------------------------------------- spokenText + wav */

await t("spokenText strips markdown down to words", () => {
  const s = spokenText("## عنوان\n**سلام** [دنیا](https://x) `کد` و\n- گزینه\n```\nکد\n```");
  assert.equal(s, "عنوان سلام دنیا کد و گزینه");
});

await t("spokenText never grows past the spoken limit", () => {
  assert.ok(spokenText("س".repeat(9000)).length <= 1500);
});

await t("pcmToWav writes a valid 44-byte header over the raw pcm", () => {
  const wav = pcmToWav(PCM);
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(v.getUint32(4, true), 36 + PCM.length, "RIFF size");
  assert.equal(v.getUint32(24, true), 24000, "sample rate");
  assert.equal(v.getUint16(34, true), 16, "bits per sample");
  assert.equal(wav.length, 44 + PCM.length);
  assert.deepEqual(wav.slice(44), PCM, "payload passes through untouched");
});

/* ---------------------------------------------------------------- speak */

await t("speak opens a live session and comes back with a wav", async () => {
  setup();
  const wav = await speak(env({ GEMINI_API_KEY: "AQ.test" }), {}, "سلام دنیا");
  assert.ok(lastSock.accepted, "the outbound socket must be accepted");
  const session = lastSock.sent[0].setup;
  assert.equal(session.model, "models/gemini-3.8-live");
  assert.deepEqual(session.generationConfig.responseModalities, ["AUDIO"]);
  const turn = lastSock.sent[1].clientContent;
  assert.equal(turn.turnComplete, true);
  assert.equal(turn.turns[0].parts[0].text, "سلام دنیا");
  assert.equal(wav.length, 44 + PCM.length);
  assert.ok(lastSock.closed, "the session closes after its one turn");
});

await t("markdown never reaches the microphone", async () => {
  setup();
  await speak(env({ GEMINI_API_KEY: "k" }), {}, modelReply);
  assert.equal(lastSock.sent[1].clientContent.turns[0].parts[0].text, "جواب صوتی با لینک و کد");
});

await t("binary frames carry audio too", async () => {
  setup((sock, msg) => {
    if (msg.setup) sock.emit("message", JSON.stringify({ setupComplete: {} }));
    else if (msg.clientContent) {
      const jsonFrame = JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: PCM_B64 } }] } } });
      sock.emit("message", new Blob([jsonFrame])); // Blob, not string — the runtime may pick either
      sock.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
    }
  });
  const wav = await speak(env({ GEMINI_API_KEY: "k" }), {}, "بگو");
  assert.equal(wav.length, 44 + PCM.length);
});

await t("a server error rejects with the reason", async () => {
  setup((sock, msg) => {
    if (msg.setup) sock.emit("message", JSON.stringify({ error: { message: "quota exceeded" } }));
  });
  await assert.rejects(() => speak(env({ GEMINI_API_KEY: "k" }), {}, "x"), /quota exceeded/);
});

await t("a socket that dies before any audio is an error", async () => {
  setup((sock) => sock.emitClose());
  await assert.rejects(() => speak(env({ GEMINI_API_KEY: "k" }), {}, "x"), /closed before any audio/);
});

await t("audio that arrived but never completed still counts", async () => {
  setup((sock, msg) => {
    if (msg.setup) sock.emit("message", JSON.stringify({ setupComplete: {} }));
    else if (msg.clientContent) {
      sock.emit("message", JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: PCM_B64 } }] } } }));
      sock.emitClose(); // connection died mid-turn — a short answer beats an error
    }
  });
  const wav = await speak(env({ GEMINI_API_KEY: "k" }), {}, "x");
  assert.equal(wav.length, 44 + PCM.length);
});

await t("a silent session times out instead of hanging the reply", async () => {
  setLiveTimeout(60);
  try {
    setup(() => {});
    await assert.rejects(() => speak(env({ GEMINI_API_KEY: "k" }), {}, "x"), /timed out/);
  } finally {
    setLiveTimeout(25_000);
  }
});

await t("without a key the bot does not even dial", async () => {
  await assert.rejects(() => speak(env(), {}, "x"), /GEMINI_API_KEY/);
});

/* ---------------------------------------------------------------- through the bot */

await t("a voice note is answered with audio, not with text", async () => {
  setup();
  const E = env({ GEMINI_API_KEY: "AQ.test", CONFIG: fakeKV() });
  await push(voiceNote(), E);

  const audio = tg.filter((c) => c.method === "sendAudio");
  assert.equal(audio.length, 1, "exactly one audio reply");
  assert.equal(audio[0].name, "sayyad.wav");
  assert.equal(audio[0].type, "audio/wav");
  assert.equal(String.fromCharCode(...audio[0].bytes.slice(0, 4)), "RIFF", "the payload is a wav");
  assert.equal(sentMessages().length, 0, "no text twin next to the voice");
  assert.equal(stats(E).replies, 1);
  assert.equal(stats(E).requests, 1, "a voice counts against the daily cap");
});

await t("a broken live session gets a friendly error and is counted", async () => {
  setup((sock, msg) => {
    if (msg.setup) sock.emit("message", JSON.stringify({ error: { message: "backend exploded" } }));
  });
  const E = env({ GEMINI_API_KEY: "AQ.test", CONFIG: fakeKV() });
  await push(voiceNote(), E);

  assert.equal(tg.filter((c) => c.method === "sendAudio").length, 0, "no half-broken audio goes out");
  const msgs = sentMessages();
  assert.equal(msgs.length, 1, "exactly one error message");
  assert.match(msgs[0].body.text, /دوباره/, "friendly, never technical");
  assert.ok(stats(E).errors >= 1, "the failure is counted");
});

await t("with the voice switch off a note falls back to a text answer", async () => {
  setup();
  const E = env({
    GEMINI_API_KEY: "AQ.test",
    CONFIG: fakeKV({ "config:v2": JSON.stringify({ voice: { enabled: false } }) }),
  });
  await push(voiceNote(), E);

  assert.equal(tg.filter((c) => c.method === "sendAudio").length, 0, "switch respected");
  assert.equal(sentMessages().length, 1, "plain text answer instead");
  assert.ok(sentMessages()[0].body.text.includes("جواب"), "the model's answer, rendered");
});

done("voice");
