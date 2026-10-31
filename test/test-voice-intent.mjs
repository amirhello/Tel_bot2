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

await t("detectIntent fast regex detects search keywords in 0ms without fetch", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return json({ candidates: [] });
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "قیمت دلار چنده؟", c);
    assert.deepEqual(res, { search: true, voice: false });
    assert.equal(fetchCalled, false, "Should not make network call for regex-matched search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent fast regex detects voice requests in 0ms without fetch", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return json({ candidates: [] });
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "برام با ویس بگو", c);
    assert.deepEqual(res, { search: false, voice: true });
    assert.equal(fetchCalled, false, "Should not make network call for explicit voice request");
    assert.equal(await detectVoiceIntent(env({ GEMINI_API_KEY: "test_key" }), "برام با ویس بگو", c), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent fast regex detects explicit negative voice requests", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return json({ candidates: [] });
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "ویس نفرست فقط متنی بگو", c);
    assert.deepEqual(res, { search: false, voice: false });
    assert.equal(fetchCalled, false, "Should not make network call for negative voice request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent skips ordinary messages without voice/search keywords in 0ms", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return json({ candidates: [] });
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "سلام سید چطوری؟", c);
    assert.deepEqual(res, { search: false, voice: false });
    assert.equal(fetchCalled, false, "Should skip LLM call entirely for ordinary chatter");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent falls back to Gemini 3.1 Flash Lite only for nuanced colloquial voice hints", async () => {
  let classifierPrompt = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    classifierPrompt = body.contents?.[0]?.parts?.[0]?.text || "";
    return json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ search: false, voice: true }) }] } }],
    });
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "حوصله خوندن ندارم برام تعریف کن", c);
    assert.deepEqual(res, { search: false, voice: true });
    assert.equal(classifierPrompt, "حوصله خوندن ندارم برام تعریف کن");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t("detectIntent correctly parses combined search=true and voice=true", async () => {
  const c = cfg();
  const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "آخرین اخبار زلزله رو با ویس بگو", c);
  assert.deepEqual(res, { search: true, voice: true });
});

await t("detectIntent falls back safely to false/false on classifier error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  try {
    const c = cfg();
    const res = await detectIntent(env({ GEMINI_API_KEY: "test_key" }), "حوصله خوندن ندارم برام تعریف کن", c);
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
