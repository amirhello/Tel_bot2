import { assert, t, done, M, env, json } from "./harness.mjs";

const { toOpenAIPart, completeOpenAI, toGeminiPart, buildGeminiBody, readGeminiText, thinkingConfig, safetySettings, completeGemini, complete, endpointOf, providerFor, ApiError } = M;

const cfg = (over = {}) => ({
  ...M.normalizeConfig({ personas: M.DEFAULT_PERSONAS, ...over }, M.DEFAULT_PERSONAS),
});
// the pool would mask a single-provider regression; this suite tests one backend at a time
cfg.single = (over) => {
  const c = cfg(over);
  c.provider.modelPool = [c.provider.model];
  return c;
};

const IMAGE = { type: "image", mime: "image/jpeg", data: "QUJD" };
const VIDEO = { type: "video", mime: "video/mp4", data: "REVG" };
const AUDIO = { type: "audio", mime: "audio/ogg", data: "QUZJ" };

/* ---------------------------------------------------------------- openai shape */

await t("neutral parts become OpenAI content parts", () => {
  assert.deepEqual(toOpenAIPart({ type: "text", text: "hi" }), { type: "text", text: "hi" });
  assert.deepEqual(toOpenAIPart(IMAGE), { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
  assert.deepEqual(toOpenAIPart(VIDEO), { type: "video_url", video_url: { url: "data:video/mp4;base64,REVG" } });
  assert.deepEqual(toOpenAIPart(AUDIO), { type: "input_audio", input_audio: { data: "QUZJ", format: "ogg" } });
  assert.equal(toOpenAIPart({ type: "sticker" }), null);
});

await t("audio format is derived from the mime type", () => {
  for (const [mime, want] of [["audio/ogg", "ogg"], ["audio/ogg; codecs=opus", "ogg"], ["audio/wav", "wav"], ["audio/mpeg", "mp3"], ["audio/mp3", "mp3"], ["weird/thing", "wav"]]) {
    assert.equal(toOpenAIPart({ type: "audio", mime, data: "x" }).input_audio.format, want, mime);
  }
});

/* ---------------------------------------------------------------- gemini shape */

await t("neutral parts become Gemini inlineData", () => {
  assert.deepEqual(toGeminiPart({ type: "text", text: "hi" }), { text: "hi" });
  assert.deepEqual(toGeminiPart(IMAGE), { inlineData: { mimeType: "image/jpeg", data: "QUJD" } });
  assert.deepEqual(toGeminiPart(VIDEO), { inlineData: { mimeType: "video/mp4", data: "REVG" } });
  assert.deepEqual(toGeminiPart(AUDIO), { inlineData: { mimeType: "audio/ogg", data: "QUZJ" } });
});

await t("Gemini gets the system prompt as its own field, not a message", () => {
  const body = buildGeminiBody(cfg({ thinking: "medium" }), { system: "SYS", parts: [{ type: "text", text: "Q" }], maxTokens: 500 });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Q" }] }]);
  assert.equal(body.generationConfig.maxOutputTokens, 500);
});

await t("video and audio travel as inlineData on the native path", () => {
  const body = buildGeminiBody(cfg(), { system: "S", parts: [VIDEO, AUDIO, { type: "text", text: "چیست؟" }], maxTokens: 100 });
  assert.equal(body.contents[0].parts.length, 3);
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: "video/mp4", data: "REVG" } });
  assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: "audio/ogg", data: "QUZJ" } });
});

await t("thinking maps to thinkingConfig, and 'off' simply omits it", () => {
  assert.deepEqual(thinkingConfig(cfg({ thinking: "medium" })), { thinkingConfig: { thinkingLevel: "medium", includeThoughts: false } });
  assert.deepEqual(thinkingConfig(cfg({ thinking: "high" })).thinkingConfig.thinkingLevel, "high");
  assert.deepEqual(thinkingConfig(cfg({ thinking: "off" })), {}, "Gemini 3 cannot be switched off; omitting is the only safe move");
});

await t("safety settings cover all four categories with the configured levels", () => {
  const s = safetySettings(cfg({ safety: { harassment: "OFF", hateSpeech: "BLOCK_LOW_AND_ABOVE", sexuallyExplicit: "BLOCK_NONE", dangerous: "BLOCK_NONE" } }));
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((x) => x.category), [
    "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT",
  ]);
  assert.equal(s[0].threshold, "OFF");
  assert.equal(s[1].threshold, "BLOCK_LOW_AND_ABOVE");
});

await t("a blank Gemini reply is reported as an error, not sent to Telegram", () => {
  assert.equal(readGeminiText({ candidates: [{ content: { parts: [{ text: "سلام" }] } }] }), "سلام");
  assert.equal(readGeminiText({ candidates: [{ content: { parts: [] } }] }), "");
  assert.equal(readGeminiText({ candidates: [{ content: { parts: [{ thought: true, text: "internal" }, { text: "ok" }] } }] }), "ok", "thoughts must be filtered out");
  assert.equal(readGeminiText({}), "");
});

/* ---------------------------------------------------------------- dispatcher */

await t("endpointOf describes the real call for each provider", () => {
  assert.match(endpointOf(cfg({ provider: { kind: "gemini", model: "gemini-3.8-flash", baseUrl: "https://g/v1beta" } })), /\/models\/gemini-3\.8-flash:generateContent$/);
  assert.match(endpointOf(cfg({ provider: { kind: "openai", baseUrl: "https://r/api/v1" } })), /\/chat\/completions$/);
});

await t("an unset base URL follows the provider kind", () => {
  const g = cfg({ provider: { kind: "gemini", baseUrl: "" } });
  const o = cfg({ provider: { kind: "openai", baseUrl: "" } });
  assert.match(g.provider.baseUrl, /generativelanguage\.googleapis\.com/);
  assert.match(o.provider.baseUrl, /openrouter\.ai/);
});

await t("an unknown provider fails loudly", () => {
  // providerFor() is the last line of defence; config normalisation normally catches this first.
  assert.throws(() => providerFor({ provider: { kind: "psychic" } }), /unknown provider/);
  assert.throws(() => providerFor({ provider: {} }), /unknown provider/);
});

/* ---------------------------------------------------------------- live calls */

let lastCall = null;
let responder = () => json({ choices: [{ message: { content: "ok" } }] });

globalThis.fetch = async (url, init) => {
  lastCall = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
  return responder(lastCall);
};

await t("the OpenAI-compatible call hits /chat/completions with a bearer token", async () => {
  const c = cfg({ provider: { kind: "openai", model: "gpt-x", baseUrl: "https://api.justwoker.icu/v1" }, thinking: "off" });
  const r = await complete(env({ API_KEY: "sk-1", OPENROUTER_API_KEY: "sk-or-legacy" }), c, {
    system: "S",
    parts: [{ type: "text", text: "Q" }, IMAGE],
    maxTokens: 700,
  });
  assert.equal(r.text, "ok");
  assert.equal(lastCall.url, "https://api.justwoker.icu/v1/chat/completions");
  assert.equal(lastCall.headers.authorization, "Bearer sk-1", "API_KEY wins over the legacy name");
  assert.equal(lastCall.body.model, "gpt-x");
  assert.equal(lastCall.body.max_tokens, 700);
  assert.deepEqual(lastCall.body.messages[0], { role: "system", content: "S" });
  assert.equal(lastCall.body.messages[1].content[1].type, "image_url");
});

await t("a provider that rejects the reasoning hint is retried without it", async () => {
  const seen = [];
  responder = (call) => {
    seen.push(call.body);
    return call.body.reasoning ? json({ error: { message: "no reasoning here" } }, 400) : json({ choices: [{ message: { content: "ok" } }] });
  };
  const r = await complete(env({ API_KEY: "sk-1" }), cfg({ provider: { kind: "openai", baseUrl: "https://x/v1" }, thinking: "medium" }), {
    system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
  });
  assert.equal(r.text, "ok");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].reasoning, { effort: "medium" });
  assert.equal(seen[1].reasoning, undefined);
  responder = () => json({ choices: [{ message: { content: "ok" } }] });
});

await t("a 429 is retried with a backoff, then reported", async () => {
  let calls = 0;
  responder = () => {
    calls++;
    return json({ error: { message: "Rate limit exceeded" } }, 429);
  };
  const started = Date.now();
  await assert.rejects(
    () => complete(env({ API_KEY: "sk-1" }), cfg({ provider: { kind: "openai", baseUrl: "https://x/v1" }, thinking: "off" }), {
      system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
    }),
    /429/,
  );
  assert.equal(calls, 3, "a 429 is transient: two retries, then it surfaces");
  assert.ok(Date.now() - started >= 2600, "the backoff between attempts must actually be spent");
  responder = () => json({ choices: [{ message: { content: "ok" } }] });
});

await t("a 429 that clears on the second try never reaches the user", async () => {
  let calls = 0;
  responder = () => (++calls === 1 ? json({ error: { message: "slow down" } }, 429) : json({ choices: [{ message: { content: "ok" } }] }));
  const r = await complete(env({ API_KEY: "sk-1" }), cfg({ provider: { kind: "openai", baseUrl: "https://x/v1" }, thinking: "off" }), {
    system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
  });
  assert.equal(r.text, "ok");
  assert.equal(calls, 2);
  responder = () => json({ choices: [{ message: { content: "ok" } }] });
});

await t("the Gemini call uses the native endpoint and the x-goog-api-key header", async () => {
  responder = () => json({ candidates: [{ content: { parts: [{ text: "سلام" }] } }], usageMetadata: { totalTokenCount: 9 } });
  const r = await complete(env({ GEMINI_API_KEY: "AQ.test" }), cfg({ provider: { kind: "gemini", model: "gemini-3.8-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, thinking: "medium" }), {
    system: "S", parts: [VIDEO, { type: "text", text: "چیست؟" }], maxTokens: 300,
  });
  assert.equal(r.text, "سلام");
  assert.equal(r.usage.totalTokenCount, 9);
  assert.equal(lastCall.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(lastCall.headers["x-goog-api-key"], "AQ.test");
  assert.equal(lastCall.headers.authorization, undefined);
  assert.deepEqual(lastCall.body.contents[0].parts[0], { inlineData: { mimeType: "video/mp4", data: "REVG" } });
  assert.equal(lastCall.body.safetySettings.length, 4);
});

await t("a Gemini block is reported with the reason instead of an empty message", async () => {
  responder = () => json({ candidates: [{ content: { parts: [] } }], promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(
    () => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg({ provider: { kind: "gemini" } }), { system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10 }),
    /blocked: SAFETY/,
  );
  responder = () => json({ choices: [{ message: { content: "ok" } }] });
});

await t("a missing key falls back to the other provider", async () => {
  responder = (call) =>
    String(call.url).includes("generativelanguage")
      ? json({ candidates: [{ content: { parts: [{ text: "from gemini" }] } }] })
      : json({ choices: [{ message: { content: "from openai" } }] });

  // no GEMINI_API_KEY -> Gemini reports a credential problem -> OpenAI takes over
  const a = await complete(env({ OPENROUTER_API_KEY: "sk-or-x" }), cfg({ provider: { kind: "gemini" } }), {
    system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
  });
  assert.equal(a.text, "from openai");

  // and the same the other way round
  const b = await complete(env({ GEMINI_API_KEY: "AQ.x" }), cfg({ provider: { kind: "openai", baseUrl: "https://x/v1" } }), {
    system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
  });
  assert.equal(b.text, "from gemini");
});

await t("a real failure is never silently rerouted to another provider", async () => {
  const urls = [];
  responder = (call) => {
    urls.push(call.url);
    if (String(call.url).includes("generativelanguage")) {
      return json({ error: { message: "prompt is invalid" } }, 400);
    }
    return json({ choices: [{ message: { content: "wrongly rerouted" } }] });
  };
  await assert.rejects(
    () => complete(env({ GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "sk-or-x" }), cfg.single({ provider: { kind: "gemini" } }), {
      system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
    }),
    /400/,
  );
  // Gemini drops its optional blocks one at a time, but never leaves the provider.
  assert.equal(urls.length, 3, "three shapes tried");
  assert.ok(urls.every((u) => u.includes("generativelanguage")), "nothing hit the OpenAI path");
});

await t("a non-JSON body becomes a readable error, not a crash", async () => {
  responder = () => new Response("<html>403</html>", { status: 403 });
  await assert.rejects(
    () => completeOpenAI(env({ API_KEY: "k" }), cfg({ provider: { kind: "openai", baseUrl: "https://x/v1" }, thinking: "off" }), {
      system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10,
    }),
    /non-JSON \(403\)/,
  );
});

done();