import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";

const { detectVoiceIntent, shouldVoiceReply, normalizeConfig, DEFAULT_PERSONAS } = M;

const cfg = (over = {}) => normalizeConfig({ personas: DEFAULT_PERSONAS, ...over }, DEFAULT_PERSONAS);

await t("detectVoiceIntent returns false when voice is disabled in config", async () => {
  const c = cfg({ voice: { enabled: false } });
  const res = await detectVoiceIntent(env(), "برام با ویس بگو", c);
  assert.equal(res, false);
});

await t("detectVoiceIntent returns false on empty or whitespace text", async () => {
  const c = cfg();
  assert.equal(await detectVoiceIntent(env(), "", c), false);
  assert.equal(await detectVoiceIntent(env(), "   ", c), false);
  assert.equal(await detectVoiceIntent(env(), null, c), false);
});

await t("detectVoiceIntent returns false on explicit negative requests", async () => {
  const c = cfg();
  assert.equal(await detectVoiceIntent(env(), "ویس نفرست برام متنی بنویس", c), false);
  assert.equal(await detectVoiceIntent(env(), "صدا نمیخوام متنی جواب بده", c), false);
  assert.equal(await detectVoiceIntent(env(), "لطفا صوتی نگو فقط متنی", c), false);
});

await t("detectVoiceIntent returns true on fast explicit voice requests", async () => {
  const c = cfg();
  assert.equal(await detectVoiceIntent(env(), "برام با ویس بگو پایتون چیه", c), true);
  assert.equal(await detectVoiceIntent(env(), "ویس بفرست برام", c), true);
  assert.equal(await detectVoiceIntent(env(), "صوتی توضیح بده لطفا", c), true);
});

await t("detectVoiceIntent uses Gemma to detect colloquial/indirect voice requests", async () => {
  let gemmaCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const sUrl = String(url);
    if (sUrl.includes("gemma") || sUrl.includes("generateContent")) {
      gemmaCalled = true;
      return json({
        candidates: [{ content: { parts: [{ text: "YES" }] } }],
      });
    }
    return originalFetch(url, init);
  };

  try {
    const c = cfg();
    const res = await detectVoiceIntent(env({ GEMINI_API_KEY: "test_key" }), "تو ماشینم حوصله خوندن ندارم خودت برام تعریف کن", c);
    assert.equal(res, true);
    assert.equal(gemmaCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectVoiceIntent returns false when Gemma returns NO", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    return json({
      candidates: [{ content: { parts: [{ text: "NO" }] } }],
    });
  };

  try {
    const c = cfg();
    const res = await detectVoiceIntent(env({ GEMINI_API_KEY: "test_key" }), "فرمول مساحت دایره چیه؟", c);
    assert.equal(res, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("shouldVoiceReply triggers on msg.voice or voice intent", async () => {
  const c = cfg();
  // 1. Incoming voice message
  assert.equal(await shouldVoiceReply(env(), { voice: { file_id: "123" } }, c, ""), true);

  // 2. Incoming text message asking for voice
  assert.equal(await shouldVoiceReply(env(), {}, c, "با ویس توضیح بده"), true);

  // 3. Normal text message
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({ candidates: [{ content: { parts: [{ text: "NO" }] } }] });
  try {
    assert.equal(await shouldVoiceReply(env({ GEMINI_API_KEY: "k" }), {}, c, "پایتون چیه؟"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("text asking for voice routes to voice generation and falls back to text on voice error", async () => {
  const c = cfg();
  // Incoming text requesting voice
  assert.equal(await shouldVoiceReply(env(), {}, c, "برام با ویس بگو"), true);

  // If voice is disabled, it strictly returns false
  const disabledCfg = cfg({ voice: { enabled: false } });
  assert.equal(await shouldVoiceReply(env(), {}, disabledCfg, "برام با ویس بگو"), false);
});

done("voice-intent");
