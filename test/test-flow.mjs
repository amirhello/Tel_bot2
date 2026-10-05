import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";

const worker = M.default;
const { signWebhookSecret } = M;

const BOT = 777;

/* ---------------------------------------------------------------- fakes */

let tg = [];
let model = [];
let reply = "**سلام** دنیا";
let modelFail = null;
let lastModelBody = null;

globalThis.fetch = async (url, init) => {
  const u = String(url);

  if (u.endsWith("/getMe")) return json({ ok: true, result: { id: BOT, username: "ai_seyed_bot" } });
  if (u.endsWith("/getFile")) return json({ ok: true, result: { file_path: "media/f.bin" } });
  if (u.endsWith("/setWebhook")) return json({ ok: true, result: true });
  if (u.endsWith("/deleteWebhook")) return json({ ok: true, result: true });
  if (u.endsWith("/getWebhookInfo")) return json({ ok: true, result: { url: "https://x.dev", pending_update_count: 0 } });

  if (u.includes("/sendMessage")) {
    const body = JSON.parse(init.body);
    // mirror the real API's refusals so the splitting and fallback code is exercised
    if (typeof body.text !== "string") return json({ ok: false, description: "can't parse entities" });
    if (body.text.length > 4096) return json({ ok: false, description: "message is too long" });
    tg.push({ method: "sendMessage", body });
    return json({ ok: true, result: { message_id: 1 } });
  }
  if (u.includes("/sendChatAction")) {
    tg.push({ method: "sendChatAction", body: JSON.parse(init.body) });
    return json({ ok: true, result: true });
  }
  if (u.includes("/file/bot")) return new Response(new Uint8Array(64).fill(3), { status: 200 });

  model.push(String(url));
  lastModelBody = JSON.parse(init.body);
  // a factory, not a Response: a Response body can only be read once, and the client
  // may legitimately make more than one attempt. Returning null means "let this one through".
  if (modelFail) {
    const forced = typeof modelFail === "function" ? modelFail() : modelFail;
    if (forced) return forced;
  }
  if (u.includes("generativelanguage")) {
    return json({ candidates: [{ content: { parts: [{ text: reply }] } }], usageMetadata: { totalTokenCount: 12 } });
  }
  return json({ choices: [{ message: { content: reply } }], usage: { total_tokens: 12 } });
};

/* ---------------------------------------------------------------- harness */

let updateId = 1000;
let E;

/** A fresh environment per test: no capture, KV or model state can leak between cases. */
function setup(extra = {}, kvSeed = {}) {
  tg = [];
  model = [];
  reply = "**سلام** دنیا";
  modelFail = null;
  lastModelBody = null;
  E = env({ GEMINI_API_KEY: "AQ.test", OPENROUTER_API_KEY: "sk-or-x", ...extra, CONFIG: fakeKV(kvSeed) });
  return E;
}

async function push(message, override = E) {
  tg = [];
  model = [];
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

const sent = () => tg.filter((c) => c.method === "sendMessage");
const archive = (e = E) => JSON.parse(e.CONFIG.store["log:v1"] ?? "[]");
const stats = (e = E) => JSON.parse(e.CONFIG.store["stats:v2"] ?? "{}");

const groupMsg = (over = {}) => ({
  message_id: 10,
  date: 1700000000,
  chat: { id: -1001, type: "supergroup", title: "رفیق‌ها" },
  from: { id: 42, is_bot: false, first_name: "رضا" },
  text: "سید این چیه؟",
  ...over,
});

const dm = (over = {}) => ({
  message_id: 11,
  date: 1700000000,
  chat: { id: 42, type: "private" },
  from: { id: 42, is_bot: false, first_name: "رضا" },
  text: "قیمت دلار چنده؟",
  ...over,
});

const userText = () => lastModelBody.contents[0].parts.map((p) => p.text ?? "").join("\n");

/* ---------------------------------------------------------------- webhook */

await t("the webhook answers 200 immediately and works in the background", async () => {
  setup();
  const res = await push(groupMsg());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].body.chat_id, -1001);
  assert.equal(sent()[0].body.reply_parameters.message_id, 10);
  assert.ok(tg.some((c) => c.method === "sendChatAction"), "the typing action must be sent");
});

await t("a group message without the wake word is archived and left alone", async () => {
  setup();
  await push(groupMsg({ text: "سلام بچه‌ها" }));
  assert.equal(sent().length, 0);
  assert.equal(model.length, 0, "the model must not be called");
  assert.equal(archive().length, 1);
  assert.equal(archive()[0].a, false);
});

await t("a private message is always answered", async () => {
  setup();
  await push(dm());
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].body.reply_parameters.message_id, 11);
});

await t("messages from other bots are neither answered nor archived", async () => {
  setup();
  await push(groupMsg({ from: { id: 9, is_bot: true, first_name: "Other" } }));
  assert.equal(sent().length, 0);
  assert.equal(archive().length, 0);
});

await t("channel posts are ignored", async () => {
  setup();
  await push(groupMsg({ chat: { id: -100, type: "channel", title: "کانال" } }));
  assert.equal(sent().length, 0);
  assert.equal(archive().length, 0);
});

await t("a wrong secret token is rejected before anything is read", async () => {
  setup();
  const res = await worker.fetch(
    new Request("https://x.dev/", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: "{}" }),
    E,
    { waitUntil() {} },
  );
  assert.equal(res.status, 403);
  assert.equal(model.length, 0);
});

await t("the same update_id is never answered twice", async () => {
  setup();
  const id = updateId++;
  const body = JSON.stringify({ update_id: id, message: groupMsg() });
  const headers = { "x-telegram-bot-api-secret-token": await signWebhookSecret(E.ADMIN_PASSWORD) };
  for (let i = 0; i < 2; i++) {
    const p = [];
    await worker.fetch(new Request("https://x.dev/", { method: "POST", headers, body }), E, { waitUntil: (x) => p.push(x) });
    await Promise.all(p);
  }
  assert.equal(model.length, 1, "Telegram's retry must not produce a second answer");
  assert.equal(sent().length, 1, "and must not send a second reply");
});

/* ---------------------------------------------------------------- context */

await t("the reply target is sent as labelled context", async () => {
  setup();
  await push(groupMsg({
    text: "سید این چی میگه؟",
    reply_to_message: { message_id: 9, from: { id: 42, is_bot: false }, chat: { id: -1001, type: "supergroup" }, date: 1, text: "من پول نمی‌دم" },
  }));
  assert.match(userText(), /پیامی که کاربر به آن ریپلای کرده/);
  assert.match(userText(), /> من پول نمی‌دم/);
  assert.match(userText(), /> سید این چی میگه؟/);
});

await t("replying to Sayyad carries its own previous answer", async () => {
  setup();
  await push(groupMsg({ text: "بیشتر توضیح بده", reply_to_message: { message_id: 9, from: { id: BOT, is_bot: true }, chat: { id: -1001, type: "supergroup" }, date: 1, text: "جواب قبلی" } }));
  assert.match(userText(), /پیام قبلی خودت/);
});

/* ---------------------------------------------------------------- media */

await t("a photo is attached to the Gemini request as inlineData", async () => {
  setup();
  await push(groupMsg({ text: "سید این چیه؟", photo: [{ file_id: "p1", file_size: 100 }, { file_id: "p2", file_size: 900_000 }] }));
  assert.match(model[0], /generativelanguage/);
  const img = lastModelBody.contents[0].parts.find((p) => p.inlineData?.mimeType === "image/jpeg");
  assert.ok(img, "no inlineData image");
  assert.ok(img.inlineData.data.length > 0);
});

await t("a video travels the same way", async () => {
  setup();
  await push(groupMsg({ text: "سید این چیه؟", video: { file_id: "v1", file_size: 900_000, mime_type: "video/mp4" } }));
  assert.ok(lastModelBody.contents[0].parts.some((p) => p.inlineData?.mimeType === "video/mp4"));
});

await t("an oversized video becomes a readable note instead of a truncated upload", async () => {
  setup();
  await push(groupMsg({ text: "سید این چیه؟", video: { file_id: "v2", file_size: 9_000_000, mime_type: "video/mp4" } }));
  assert.ok(!lastModelBody.contents[0].parts.some((p) => p.inlineData));
  assert.match(userText(), /8\.6 MB — over the 4 MB limit/);
  assert.equal(sent().length, 1, "the rest of the message must still be answered");
});

await t("a voice note is sent as audio so the model can hear it", async () => {
  setup();
  await push(groupMsg({ text: "سید چی میگه؟", voice: { file_id: "a1", file_size: 20_000, mime_type: "audio/ogg" } }));
  assert.ok(lastModelBody.contents[0].parts.some((p) => p.inlineData?.mimeType === "audio/ogg"));
});

await t("a per-type switch in the config really disables that media", async () => {
  setup({}, { "config:v2": JSON.stringify({ media: { video: { enabled: false } } }) });
  await push(groupMsg({ text: "سید چیه؟", video: { file_id: "v3", file_size: 900_000, mime_type: "video/mp4" } }));
  assert.ok(!lastModelBody.contents[0].parts.some((p) => p.inlineData));
  assert.match(userText(), /turned off/);
});

await t("media never leaks into the archive", async () => {
  setup();
  await push(groupMsg({ text: "سید", photo: [{ file_id: "p", file_size: 10 }] }));
  const row = archive()[0];
  assert.equal(row.k, "photo");
  assert.ok(!JSON.stringify(row).includes("base64"));
});

/* ---------------------------------------------------------------- commands */

await t("commands answer without touching the model", async () => {
  for (const [cmd, re] of [["/ping", /pong/], ["/help", /سید/], ["/start@ai_seyed_bot", /سید/]]) {
    setup();
    await push(dm({ text: cmd }));
    assert.equal(model.length, 0, `${cmd} must not call the model`);
    assert.match(sent()[0].body.text, re, cmd);
  }
});

/* ---------------------------------------------------------------- providers */

await t("the OpenAI-compatible provider is used when the panel says so", async () => {
  setup({}, { "config:v2": JSON.stringify({ provider: { kind: "openai", model: "stealth/space-bunny-alpha", baseUrl: "https://openrouter.ai/api/v1" } }) });
  await push(groupMsg());
  assert.equal(model[0], "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(lastModelBody.model, "stealth/space-bunny-alpha");
  // the same prompt, in the other wire shape
  assert.equal(lastModelBody.systemInstruction, undefined);
  assert.ok(lastModelBody.messages[0].content.includes("تو «سید» هستی"));
});

await t("with no Gemini key the bot falls back rather than going silent", async () => {
  setup({ GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-x" });
  await push(groupMsg());
  assert.equal(model[0], "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent().length, 1);
});

/* ---------------------------------------------------------------- output */

await t("a long answer is split into several Telegram-sized messages", async () => {
  setup();
  reply = Array.from({ length: 300 }, (_, i) => "جمله‌ی شماره " + i + " با محتوای کافی.").join("\n");
  await push(groupMsg());
  assert.ok(sent().length >= 2, `expected several messages, got ${sent().length}`);
  for (const m of sent()) assert.ok(m.body.text.length <= 4096);
});

await t("a bold-heavy long answer is split by rendered size, not raw size", async () => {
  setup();
  reply = "**متن** ".repeat(900);
  await push(groupMsg());
  assert.ok(sent().length >= 2);
  for (const m of sent()) assert.ok(m.body.text.length <= 4096, `chunk too long: ${m.body.text.length}`);
});

/* ---------------------------------------------------------------- errors */

await t("a persistent rate limit is retried, then answered with a friendly note", async () => {
  setup();
  modelFail = () => json({ error: { message: "Rate limit exceeded" } }, 429);
  await push(groupMsg());
  assert.equal(model.length, 3, "a 429 is transient: two retries before giving up");
  assert.match(sent()[0].body.text, /سقف درخواست پر شد/);
  assert.doesNotMatch(sent()[0].body.text, /Rate limit/);
});

await t("a rate limit that clears on a retry never reaches the user", async () => {
  setup();
  let n = 0;
  modelFail = () => (++n === 1 ? json({ error: { message: "slow down" } }, 429) : null);
  await push(groupMsg());
  assert.equal(model.length, 2);
  assert.equal(sent()[0].body.text, "<b>سلام</b> دنیا", "the real answer arrives instead of an apology");
});

await t("an upstream failure gets a friendly reply and is counted", async () => {
  setup();
  modelFail = () => json({ error: { message: "upstream exploded" } }, 500);
  await push(groupMsg());
  assert.doesNotMatch(sent()[0].body.text, /upstream exploded/);
  assert.equal(sent().length, 1);
  assert.ok(stats().errors >= 1);
  assert.match(stats().lastError, /upstream exploded/);
});

await t("a failing KV write never costs us the reply", async () => {
  const e = setup();
  const real = e.CONFIG.put;
  e.CONFIG.put = async () => { throw new Error("quota exceeded"); };
  await push(groupMsg(), e);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].body.text, "<b>سلام</b> دنیا");
  e.CONFIG.put = real;
});

/* ---------------------------------------------------------------- guards */

await t("the daily cap stops the model and says so once an hour", async () => {
  const today = new Date().toISOString().slice(0, 10);
  setup({}, {
    "config:v2": JSON.stringify({ dailyCap: 1 }),
    "stats:v2": JSON.stringify({ day: today, today: 1, requests: 1 }),
  });
  await push(groupMsg({ message_id: 30 }));
  assert.equal(model.length, 0, "no model call may go out");
  assert.match(sent()[0]?.body.text ?? "", /سقف روزانه/);

  await push(groupMsg({ message_id: 31 }));
  assert.equal(model.length, 0);
  assert.equal(sent().length, 0, "the notice is rate-limited to once an hour per chat");
});

await t("the master switch silences the bot but still archives", async () => {
  setup({}, { "config:v2": JSON.stringify({ enabled: false }) });
  await push(groupMsg());
  assert.equal(sent().length, 0);
  assert.equal(model.length, 0);
  assert.equal(archive().length, 1, "archiving continues even when the bot is off");
});

await t("two messages in one chat never overlap", async () => {
  setup();
  let live = 0;
  let peak = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    if (String(u).includes("generativelanguage")) {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
    }
    return real(u, i);
  };
  try {
    await Promise.all([push(groupMsg({ message_id: 40, text: "سید اول" })), push(groupMsg({ message_id: 41, text: "سید دوم" }))]);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(peak, 1, "requests overlapped inside the same chat");
});

/* ---------------------------------------------------------------- routes */

await t("the root answers and /setup points Telegram at this Worker", async () => {
  setup();
  const root = await worker.fetch(new Request("https://x.dev/"), E, { waitUntil() {} });
  assert.equal((await root.json()).ok, true);

  const s = await worker.fetch(new Request("https://x.dev/setup"), E, { waitUntil() {} });
  const d = await s.json();
  assert.equal(d.target, "https://x.dev");
  assert.equal(d.secret_token_used, true);
  assert.deepEqual(d.setWebhook.ok, true);
});

await t("/diag reports the provider and a live answer", async () => {
  setup();
  const d = await (await worker.fetch(new Request("https://x.dev/diag?format=json"), E, { waitUntil() {} })).json();
  assert.equal(d.checks.telegram.ok, true);
  assert.equal(d.checks.model.ok, true);
  assert.match(d.checks.model.sample, /سلام/);
  assert.match(d.endpoint, /:generateContent$/);
  assert.equal(d.provider, "gemini");
});

await t("/diag surfaces a provider failure instead of pretending", async () => {
  setup();
  modelFail = () => json({ error: { message: "nope" } }, 401);
  const d = await (await worker.fetch(new Request("https://x.dev/diag?format=json"), E, { waitUntil() {} })).json();
  assert.equal(d.checks.model.ok, false);
  assert.match(d.checks.model.error, /401/);
});

await t("an unknown path is a clean 404", async () => {
  setup();
  assert.equal((await worker.fetch(new Request("https://x.dev/nope"), E, { waitUntil() {} })).status, 404);
});

done();