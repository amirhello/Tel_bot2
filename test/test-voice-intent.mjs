import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";

const { detectIntent, detectVoiceIntent, shouldVoiceReply, normalizeConfig, DEFAULT_PERSONAS, parseIntentJson } = M;

const cfg = (over = {}) => normalizeConfig({ personas: DEFAULT_PERSONAS, ...over }, DEFAULT_PERSONAS);

await t("detectVoiceIntent returns false when voice is disabled in config", async () => {
  const c = cfg({ voice: { enabled: false } });
  const res = await detectVoiceIntent(env(), "برام با ویس بگو", c);
  assert.equal(res, false);
});

await t("detectIntent returns false on empty or whitespace text", async () => {
  const c = cfg();
  assert.deepEqual(await detectIntent(env(), "", c), { search: false, voice: false });
  assert.deepEqual(await detectIntent(env(), "   ", c), { search: false, voice: false });
  assert.deepEqual(await detectIntent(env(), null, c), { search: false, voice: false });
});

await t("detectIntent calls Gemma once and parses search and voice flags from JSON", async () => {
  let gemmaPrompt = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    gemmaPrompt = body.contents?.[0]?.parts?.[0]?.text || "";
    return json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ search: true, voice: false }) }] } }],
    });
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "قیمت دلار چنده؟", c);
    assert.deepEqual(res, { search: true, voice: false });
    assert.equal(gemmaPrompt, "قیمت دلار چنده؟");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent correctly parses voice=true when user asks for audio", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ search: false, voice: true }) }] } }],
  });

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "برام با ویس بگو", c);
    assert.deepEqual(res, { search: false, voice: true });
    assert.equal(await detectVoiceIntent(env({ GEMINI_API_KEY: "test_key" }), "برام با ویس بگو", c), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent correctly parses combined search=true and voice=true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ search: true, voice: true }) }] } }],
  });

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "آخرین اخبار زلزله رو با ویس بگو", c);
    assert.deepEqual(res, { search: true, voice: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent falls back safely to false/false on error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "سلام", c);
    assert.deepEqual(res, { search: false, voice: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("shouldVoiceReply triggers on msg.voice or voice intent", async () => {
  const c = cfg();
  // 1. Incoming voice message (does not call Gemma)
  assert.equal(await shouldVoiceReply(env(), { voice: { file_id: "123" } }, c, ""), true);

  // 2. Incoming text message asking for voice
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ search: false, voice: true }) }] } }],
  });
  try {
    assert.equal(await shouldVoiceReply(env({ GEMINI_API_KEY: "k" }), {}, c, "با ویس بگو"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 3. Normal text message
  globalThis.fetch = async () => json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ search: false, voice: false }) }] } }],
  });
  try {
    assert.equal(await shouldVoiceReply(env({ GEMINI_API_KEY: "k" }), {}, c, "پایتون چیه؟"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("text asking for voice respects disabled voice config", async () => {
  const c = cfg({ voice: { enabled: false } });
  assert.equal(await shouldVoiceReply(env(), {}, c, "برام با ویس بگو"), false);
});

done("voice-intent");
