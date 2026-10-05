import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";

const {
  quotaKind, DailyQuotaError, UnknownModelError, completeGemini,
  buildGeminiBody, thinkingConfig, safetySettings, normalizePool,
  nextPacificMidnight, loadQuota, saveQuota, poolResumeTime, DEFAULT_MODEL_POOL,
} = M;
const { complete, PoolExhausted } = M;

const cfg = (over = {}) => M.normalizeConfig({ personas: M.DEFAULT_PERSONAS, ...over }, M.DEFAULT_PERSONAS);
const payload = { system: "S", parts: [{ type: "text", text: "Q" }], maxTokens: 10 };

let calls = [];
let responder;

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init.body) });
  return responder(String(url), calls.length);
};

const geminiURL = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const quotaErr = (m, word) => json({ error: { message: `Quota exceeded for quota metric 'Generate requests': limit ${m} ${word}` } }, 429);
const ok = (text = "ok") => json({ candidates: [{ content: { parts: [{ text }] } }] });

/* ---------------------------------------------------------------- helpers */

await t("quotaKind tells a daily limit from a per-minute one", () => {
  assert.equal(quotaKind("Quota exceeded for quota metric: limit 20 per day"), "day");
  assert.equal(quotaKind("Requests per day exceeded"), "day");
  assert.equal(quotaKind("RESOURCE_EXHAUSTED: limit 5 per minute"), "minute");
  assert.equal(quotaKind("Resource has been exhausted (e.g. check quota)."), "other");
  assert.equal(quotaKind(undefined), "other");
});

await t("Pacific midnight is the next UTC-08:00 boundary", () => {
  // Google resets at 00:00 Pacific = 08:00 UTC. "Next" means the coming one, so:
  //   2026-10-04 20:00 Pacific (04:00Z) -> reset at 2026-10-04 08:00Z, ~4h away
  assert.equal(new Date(nextPacificMidnight(Date.parse("2026-10-04T04:00:00Z"))).toISOString(), "2026-10-04T08:00:00.000Z");
  //   2026-10-04 04:00 Pacific (12:00Z) -> today's midnight already passed -> next day
  assert.equal(new Date(nextPacificMidnight(Date.parse("2026-10-04T12:00:00Z"))).toISOString(), "2026-10-05T08:00:00.000Z");
  //   2026-10-04 01:00 Pacific (09:00Z) -> just after midnight, ~23h away
  assert.equal(new Date(nextPacificMidnight(Date.parse("2026-10-04T09:00:00Z"))).toISOString(), "2026-10-05T08:00:00.000Z");
  //   exactly on the boundary -> roll to the following one
  assert.equal(new Date(nextPacificMidnight(Date.parse("2026-10-04T08:00:00Z"))).toISOString(), "2026-10-05T08:00:00.000Z");
  assert.ok(nextPacificMidnight() > Date.now(), "always in the future");
});

await t("the pool is de-duplicated and always starts with the configured model", () => {
  assert.deepEqual(normalizePool(["a", "b", "a", "  ", "b"], "x"), ["x", "a", "b"]);
  assert.deepEqual(normalizePool("a\n b \n\nc\n", ""), ["a", "b", "c"]);
  assert.deepEqual(normalizePool(null, "only"), ["only"]);
  assert.ok(normalizePool(Array.from({ length: 40 }, (_, i) => "m" + i), "").length <= 25, "bounded");
});

/* ---------------------------------------------------------------- shapes */

await t("a rejected knob is dropped one at a time until the model accepts the body", async () => {
  calls = [];
  responder = (url) => (calls.length < 3 ? json({ error: { message: "unsupported field" } }, 400) : ok("finally"));
  const r = await completeGemini(env({ GEMINI_API_KEY: "k" }), cfg({ thinking: "medium" }), payload);
  assert.equal(r.text, "finally");
  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.generationConfig.thinkingConfig, "attempt 1 keeps thinkingConfig");
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined, "attempt 2 drops it");
  assert.equal(calls[2].body.safetySettings, undefined, "attempt 3 drops safety too");
});

await t("thinkingConfig and safetySettings follow the config", () => {
  assert.deepEqual(thinkingConfig(cfg({ thinking: "high" })), { thinkingConfig: { thinkingLevel: "high", includeThoughts: false } });
  assert.deepEqual(thinkingConfig(cfg({ thinking: "off" })), {});
  assert.equal(safetySettings(cfg()).length, 4);
  const noThink = buildGeminiBody(cfg(), payload, { noThinking: true });
  assert.equal(noThink.generationConfig.thinkingConfig, undefined);
  assert.equal(noThink.generationConfig.maxOutputTokens, 10, "the token limit is never dropped");
  assert.equal(buildGeminiBody(cfg(), payload, { noSafety: true }).safetySettings, undefined);
});

/* ---------------------------------------------------------------- single model */

await t("a per-minute 429 is retried by the transport, not treated as a daily cap", async () => {
  calls = [];
  responder = () => quotaErr(5, "per minute");
  await assert.rejects(() => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg(), payload), /per minute/);
  assert.ok(!calls.length || true);
  const daily = calls.length;
  assert.ok(daily >= 3, `per-minute errors are retried at the transport layer (${daily} calls)`);
});

await t("a per-day 429 becomes DailyQuotaError and is not retried", async () => {
  calls = [];
  responder = () => quotaErr(20, "per day");
  await assert.rejects(() => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg(), payload), (e) => {
    assert.ok(e instanceof DailyQuotaError);
    assert.equal(e.model, "gemini-3.8-flash");
    assert.equal(e.resetAt, nextPacificMidnight());
    return true;
  });
});

await t("an unknown model name becomes UnknownModelError", async () => {
  calls = [];
  responder = () => json({ error: { code: 404, message: "models/nope is not found" } }, 404);
  await assert.rejects(() => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg(), payload), UnknownModelError);
});

/* ---------------------------------------------------------------- pool */

await t("the pool starts with the strongest model and only moves on a quota problem", async () => {
  calls = [];
  responder = () => ok("from-first");
  const r = await complete(env({ GEMINI_API_KEY: "k" }), cfg(), payload);
  assert.equal(r.text, "from-first");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, geminiURL("gemini-3.8-flash"));
});

await t("a spent model is parked and the next one answers", async () => {
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => (url.includes("gemini-3.8-flash") ? quotaErr(20, "per day") : ok("from-second"));
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from-second");
  assert.equal(calls.length, 2);

  const parked = JSON.parse(e.CONFIG.store["quota:v1"]);
  assert.equal(parked["gemini-3.8-flash"], nextPacificMidnight(), "the spent model is remembered");
  assert.equal("gemini-3.7-flash" in parked, false, "the healthy one is not parked");
});

await t("a parked model is skipped without spending a request on it", async () => {
  const resetAt = nextPacificMidnight();
  const e = env({ GEMINI_API_KEY: "k", CONFIG: fakeKV({ "quota:v1": JSON.stringify({ "gemini-3.8-flash": resetAt }) }) });
  calls = [];
  responder = () => ok("from-second");
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from-second");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, geminiURL("gemini-3.7-flash"), "went straight to the next model");
});

await t("a genuine failure never silently reroutes to another model", async () => {
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = () => json({ error: { message: "upstream exploded" } }, 500);
  await assert.rejects(() => complete(e, cfg(), payload), /upstream exploded/);
  const models = new Set(calls.map((c) => c.url));
  assert.equal(models.size, 1, "every request went to the same model — no silent reroute");
});

await t("a typo in the pool is parked for the day instead of retried forever", async () => {
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => (url.includes("typo-model") ? json({ error: { message: "not found" } }, 404) : ok("real"));
  const c = cfg();
  c.provider.modelPool = ["typo-model", "gemini-3.8-flash"];
  const r = await complete(e, c, payload);
  assert.equal(r.text, "real");
  const parked = JSON.parse(e.CONFIG.store["quota:v1"]);
  assert.ok(parked["typo-model"], "the bad name was recorded");
  assert.equal(parked["gemini-3.8-flash"], undefined, "the working model stays available");

  // second call must skip the typo entirely
  calls = [];
  responder = () => ok("real again");
  assert.equal((await complete(e, c, payload)).text, "real again");
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes("typo-model"), "no request wasted on the bad name");
});

await t("when every model is spent the error carries the hour it frees up", async () => {
  const pool = cfg().provider.modelPool;
  const e = env({ GEMINI_API_KEY: "k", CONFIG: fakeKV() });
  calls = [];
  responder = () => quotaErr(20, "per day");

  await assert.rejects(() => complete(e, cfg(), payload), (err) => {
    assert.ok(err instanceof PoolExhausted, "got " + err.name);
    assert.equal(err.resetAt, nextPacificMidnight());
    assert.match(err.message, /model pool exhausted/);
    return true;
  });
  assert.equal(calls.length, pool.length, "every model was tried once");
  const parked = JSON.parse(e.CONFIG.store["quota:v1"]);
  assert.equal(Object.keys(parked).length, pool.length);
});

await t("the resume time is when the last parked model frees up", async () => {
  const soon = Date.now() + 60_000;
  const later = Date.now() + 3 * 3600_000;
  const q = { a: soon, b: later };
  // "a" is parked soon, "b" much later: the pool is only fully free at the later time.
  assert.equal(poolResumeTime(q, ["a", "b"]), later);
  assert.equal(poolResumeTime(q, ["a"]), soon, "a model outside the pool cannot hold us back");
  assert.ok(poolResumeTime(q, ["a", "b", "c"]) <= Date.now(), "one free model is enough");
  assert.ok(poolResumeTime({}, ["a"]) <= Date.now());
});

await t("a quota entry expires by itself, so no cleanup job is needed", async () => {
  const past = { "gemini-3.8-flash": Date.now() - 1000 };
  const e = env({ GEMINI_API_KEY: "k", CONFIG: fakeKV({ "quota:v1": JSON.stringify(past) }) });
  calls = [];
  responder = () => ok("fresh again");
  assert.equal((await complete(e, cfg(), payload)).text, "fresh again");
  assert.equal(calls[0].url, geminiURL("gemini-3.8-flash"), "an expired entry is retried");
});

await t("the quota store survives a broken KV read", async () => {
  assert.deepEqual(await loadQuota({ CONFIG: { get: () => Promise.reject(new Error("boom")) } }), {});
  const e = env({ CONFIG: fakeKV() });
  await saveQuota(e, { m: 123 });
  assert.equal((await loadQuota(e)).m, 123);
  assert.doesNotReject(() => saveQuota({ CONFIG: { put: () => Promise.reject(new Error("quota")) } }, { m: 1 }));
});

await t("a missing Gemini key still falls back to an OpenAI-compatible provider", async () => {
  calls = [];
  responder = () => json({ choices: [{ message: { content: "from openai" } }] });
  const r = await complete(env({ OPENROUTER_API_KEY: "sk-or-x" }), cfg(), payload);
  assert.equal(r.text, "from openai");
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
});

await t("the shipped default pool is ordered strongest-first and de-duplicated", () => {
  assert.ok(DEFAULT_MODEL_POOL.length >= 8);
  assert.equal(new Set(DEFAULT_MODEL_POOL).size, DEFAULT_MODEL_POOL.length);
  assert.equal(DEFAULT_MODEL_POOL[0], "gemini-3.8-flash");
  assert.ok(DEFAULT_MODEL_POOL.includes("gemini-3.5-flash-lite"), "a high-daily-quota fallback must be present");
  assert.ok(DEFAULT_MODEL_POOL.includes("Antigravity"), "last resort included");
});

done();