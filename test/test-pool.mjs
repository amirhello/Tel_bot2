import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";
import { complete, PoolExhausted, minuteQuota, clearMinuteQuota } from "../src/llm.js";
import {
  completeGemini,
  DailyQuotaError,
  MinuteQuotaError,
  UnknownModelError,
  buildGeminiBody,
  thinkingConfig,
  safetySettings,
  quotaKind,
} from "../src/providerGemini.js";
import { acquireKey, acquireKeyWithWait, clearKeyPoolCache, getKeyPool } from "../src/keyPool.js";
import {
  normalizePool,
  nextPacificMidnight,
  loadQuota,
  saveQuota,
  poolResumeTime,
  DEFAULT_MODEL_POOL,
  normalizeConfig,
} from "../src/store.js";
import { DEFAULT_PERSONAS } from "../src/prompt.js";

const cfg = (over = {}) => normalizeConfig({ personas: DEFAULT_PERSONAS, ...over }, DEFAULT_PERSONAS);
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
  assert.equal(quotaKind("Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_requests_per_day"), "day");
  assert.equal(quotaKind("RESOURCE_EXHAUSTED: limit 5 per minute"), "minute");
  assert.equal(quotaKind("Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_requests_per_minute"), "minute");
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
  assert.deepEqual(thinkingConfig(cfg({ thinking: "high" })), { thinkingConfig: { thinkingBudget: 8192 } });
  assert.deepEqual(thinkingConfig(cfg({ thinking: "off" })), { thinkingConfig: { thinkingBudget: 0 } });
  assert.equal(safetySettings(cfg()).length, 4);
  const noThink = buildGeminiBody(cfg(), payload, { noThinking: true });
  assert.equal(noThink.generationConfig.thinkingConfig, undefined);
  assert.equal(noThink.generationConfig.maxOutputTokens, 10, "the token limit is never dropped");
  assert.equal(buildGeminiBody(cfg(), payload, { noSafety: true }).safetySettings, undefined);
});

/* ---------------------------------------------------------------- single model */

await t("a per-minute 429 becomes MinuteQuotaError and is not retried with delay", async () => {
  calls = [];
  responder = () => quotaErr(5, "per minute");
  await assert.rejects(() => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg(), payload), (e) => {
    assert.ok(e instanceof MinuteQuotaError);
    assert.equal(e.model, "gemini-3.5-flash-lite");
    assert.ok(e.resetAt > Date.now() && e.resetAt <= Date.now() + 61_000);
    return true;
  });
  assert.equal(calls.length, 1, "per-minute errors fail fast without sleeping on the same model");
});

await t("a per-day 429 becomes DailyQuotaError and is not retried", async () => {
  calls = [];
  responder = () => quotaErr(20, "per day");
  await assert.rejects(() => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg(), payload), (e) => {
    assert.ok(e instanceof DailyQuotaError);
    assert.equal(e.model, "gemini-3.5-flash-lite");
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
  clearMinuteQuota();
  calls = [];
  responder = () => ok("from-first");
  const r = await complete(env({ GEMINI_API_KEY: "k" }), cfg(), payload);
  assert.equal(r.text, "from-first");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, geminiURL("gemini-3.5-flash-lite"));
});

await t("a spent model is parked and the next one answers", async () => {
  clearMinuteQuota();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => (url.includes("gemini-3.5-flash-lite") ? quotaErr(20, "per day") : ok("from-second"));
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from-second");
  assert.equal(calls.length, 2);

  const parked = JSON.parse(e.CONFIG.store["quota:v1"]);
  assert.equal(parked["gemini-3.5-flash-lite"], nextPacificMidnight(), "the spent model is remembered");
  assert.equal("gemini-3.1-flash-lite" in parked, false, "the healthy one is not parked");
});

await t("a minute-spent model is parked in-memory for 60s and the next one answers", async () => {
  clearMinuteQuota();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => (url.includes("gemini-3.5-flash-lite") ? quotaErr(5, "per minute") : ok("from-second"));
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from-second");
  assert.equal(calls.length, 2);

  assert.ok((minuteQuota.get("gemini-3.5-flash-lite") ?? 0) > Date.now(), "parked in memory");
  assert.equal(e.CONFIG.store["quota:v1"], undefined, "no writes to KV for minute quota");

  // immediate second call skips the minute-parked model
  calls = [];
  responder = () => ok("from-second-again");
  assert.equal((await complete(e, cfg(), payload)).text, "from-second-again");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, geminiURL("gemini-3.1-flash-lite"));
  clearMinuteQuota();
});

await t("Google API 429 with metric name falls back to next model in pool", async () => {
  clearMinuteQuota();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  const googleErr = json(
    {
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. * Quota exceeded for metric: generativelanguage.go",
        status: "RESOURCE_EXHAUSTED",
      },
    },
    429,
  );
  responder = (url) => (url.includes("gemini-3.5-flash-lite") ? googleErr : ok("from-second-model"));
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from-second-model");
  assert.equal(calls.length, 2);
  assert.ok(minuteQuota.has("gemini-3.5-flash-lite"));
  clearMinuteQuota();
});

await t("a parked model is skipped without spending a request on it", async () => {
  clearMinuteQuota();
  const resetAt = nextPacificMidnight();
  const e = env({ GEMINI_API_KEY: "k", CONFIG: fakeKV({ "quota:v1": JSON.stringify({ "gemini-3.5-flash-lite": resetAt }) }) });
  calls = [];
  responder = () => ok("from-second");
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from-second");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, geminiURL("gemini-3.1-flash-lite"), "went straight to the next model");
});

await t("a genuine failure never silently reroutes to another model", async () => {
  clearMinuteQuota();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = () => json({ error: { message: "upstream exploded" } }, 500);
  await assert.rejects(() => complete(e, cfg(), payload), /upstream exploded/);
  const models = new Set(calls.map((c) => c.url));
  assert.equal(models.size, 1, "every request went to the same model — no silent reroute");
});

await t("a typo in the pool is parked for the day instead of retried forever", async () => {
  clearMinuteQuota();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => (url.includes("typo-model") ? json({ error: { message: "not found" } }, 404) : ok("real"));
  const c = cfg();
  c.provider.modelPool = ["typo-model", "gemini-3.5-flash-lite"];
  const r = await complete(e, c, payload);
  assert.equal(r.text, "real");
  const parked = JSON.parse(e.CONFIG.store["quota:v1"]);
  assert.ok(parked["typo-model"], "the bad name was recorded");
  assert.equal(parked["gemini-3.5-flash-lite"], undefined, "the working model stays available");

  // second call must skip the typo entirely
  calls = [];
  responder = () => ok("real again");
  assert.equal((await complete(e, c, payload)).text, "real again");
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes("typo-model"), "no request wasted on the bad name");
});

await t("when every model is spent the error carries the hour it frees up", async () => {
  clearMinuteQuota();
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
  clearMinuteQuota();
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
  clearMinuteQuota();
  const past = { "gemini-3.5-flash-lite": Date.now() - 1000 };
  const e = env({ GEMINI_API_KEY: "k", CONFIG: fakeKV({ "quota:v1": JSON.stringify(past) }) });
  calls = [];
  responder = () => ok("fresh again");
  assert.equal((await complete(e, cfg(), payload)).text, "fresh again");
  assert.equal(calls[0].url, geminiURL("gemini-3.5-flash-lite"), "an expired entry is retried");
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
  assert.equal(DEFAULT_MODEL_POOL[0], "gemini-3.5-flash-lite");
  assert.ok(DEFAULT_MODEL_POOL.includes("gemini-3.8-flash"), "a high-quality fallback must be present");
  assert.ok(DEFAULT_MODEL_POOL.includes("Antigravity"), "last resort included");
});

await t("shapes preserves safety settings when thinking is off (Gemma support)", async () => {
  calls = [];
  responder = (url) => (calls.length < 3 ? json({ error: { message: "unsupported field" } }, 400) : ok("finally"));
  const r = await completeGemini(env({ GEMINI_API_KEY: "k" }), cfg({ thinking: "off" }), payload);
  assert.equal(r.text, "finally");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingBudget, 0, "attempt 1 keeps thinkingBudget: 0");
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined, "attempt 2 drops thinkingConfig");
  assert.ok(calls[1].body.safetySettings, "attempt 2 preserves safetySettings for Gemma");
  assert.equal(calls[2].body.safetySettings, undefined, "attempt 3 drops safety too");
});

await t("concurrent requests wait up to 1.2s for in-use key", async () => {
  clearMinuteQuota();
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEYS: "concurrent_key" });
  calls = [];
  responder = () => ok("concurrent success");

  // Acquire the key directly to simulate an in-flight request
  const h = acquireKey(e);
  assert.ok(h);

  // Release the key after 150ms
  setTimeout(() => {
    h.release();
  }, 150);

  const start = Date.now();
  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "concurrent success");
  assert.ok(Date.now() - start >= 100, "waited for the busy key to be released");
  clearKeyPoolCache();
});

await t("PoolExhausted uses fallbackReset (~60s) when keys were temporarily busy or cooling", async () => {
  clearMinuteQuota();
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEYS: "busy_cooldown_key" });

  // Set the key to rpmCooldownUntil without any daily quota
  const h = acquireKey(e);
  const err = new Error("rate limit");
  err.status = 429;
  err.name = "MinuteQuotaError";
  h.release(err);

  await assert.rejects(() => complete(e, cfg(), payload), (err) => {
    assert.ok(err instanceof PoolExhausted, "got " + err.name);
    assert.ok(err.resetAt <= Date.now() + 65_000, "resetAt is temporary cooldown (~60s)");
    assert.ok(err.resetAt > Date.now(), "resetAt is in future");
    return true;
  });
  clearKeyPoolCache();
});

await t("intelligent MALFORMED_RESPONSE and empty response falls back to next model", async () => {
  clearMinuteQuota();
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => {
    if (url.includes("gemini-3.5-flash-lite")) {
      return json({ candidates: [{ content: { parts: [] } }] }); // "Gemini returned no text"
    }
    return ok("from gemini-3.1-flash-lite");
  };

  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "from gemini-3.1-flash-lite");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes("gemini-3.5-flash-lite"));
  assert.ok(calls[1].url.includes("gemini-3.1-flash-lite"));
  assert.ok(r.trace.some((t) => t.status === "malformed_response (glitch)"));
  clearMinuteQuota();
});

await t("MALFORMED_RESPONSE in error message seamlessly falls back to next model", async () => {
  clearMinuteQuota();
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];
  responder = (url) => {
    if (url.includes("gemini-3.5-flash-lite")) {
      return json({ error: { message: "MALFORMED_RESPONSE from model backend" } }, 400);
    }
    return ok("recovered from flash");
  };

  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "recovered from flash");
  assert.ok(calls.length >= 2);
  assert.ok(calls.at(-1).url.includes("gemini-3.1-flash-lite"));
  assert.ok(r.trace.some((t) => t.status === "malformed_response (glitch)"));
  clearMinuteQuota();
});

await t("completeGemini throws immediately on the last shape error", async () => {
  calls = [];
  responder = () => json({ error: { message: "unsupported field" } }, 400);
  await assert.rejects(
    () => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg({ thinking: "off" }), payload),
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(err.message.includes("unsupported field"));
      return true;
    },
  );
  assert.equal(calls.length, 3, "tried all 3 shapes before throwing");
});

await t("model loop re-evaluates timestamp so an expired minute quota is not skipped", async () => {
  clearMinuteQuota();
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEY: "k" });
  calls = [];

  // Simulate model 2 having a minute quota that expires in 50ms
  minuteQuota.set("gemini-3.1-flash-lite", Date.now() + 50);

  // Model 1 takes 80ms to fail with 429 daily quota
  responder = (url) => {
    if (url.includes("gemini-3.5-flash-lite")) {
      const start = Date.now();
      while (Date.now() - start < 80) {} // busy wait to let 50ms expire
      return json({ error: { message: "per day quota reached" } }, 429);
    }
    return ok("answered by gemini-3.1-flash-lite");
  };

  const r = await complete(e, cfg(), payload);
  assert.equal(r.text, "answered by gemini-3.1-flash-lite");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes("gemini-3.5-flash-lite"));
  assert.ok(calls[1].url.includes("gemini-3.1-flash-lite"), "gemini-3.1-flash-lite was not skipped because cooldown expired during attempt");
  clearMinuteQuota();
});

await t("completeGemini fails fast on MALFORMED_RESPONSE without trying all 3 shapes", async () => {
  calls = [];
  responder = () => json({ error: { message: "MALFORMED_RESPONSE from backend" } }, 400);
  await assert.rejects(
    () => completeGemini(env({ GEMINI_API_KEY: "k" }), cfg({ thinking: "off" }), payload),
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(err.message.includes("MALFORMED_RESPONSE"));
      return true;
    },
  );
  assert.equal(calls.length, 1, "failed fast on first shape without wasting subsequent shapes");
});

await t("runGeminiPool throws 60s cooldown and NOT Pacific Midnight when only one model has daily quota exhausted and another key is busy", async () => {
  clearMinuteQuota();
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEYS: "k1, k2" });
  calls = [];

  // Model 1 (flash-lite) fails with daily quota error
  responder = (url) => {
    if (url.includes("gemini-3.5-flash-lite")) {
      return json({ error: { message: "Resource exhausted: per day quota reached" } }, 429);
    }
    return ok("recovered");
  };

  // Lock both keys in keyPool before second model is reached, simulating busy keys
  const pool = getKeyPool(e);
  // Let model 1 fail with daily quota on both keys
  // but for model 2 ("gemini-3.8-flash"), all keys are inUse
  const origAcquire = await import("../src/keyPool.js");
  
  // Custom cfg with two models
  const twoModelCfg = cfg({
    provider: {
      kind: "gemini",
      model: "gemini-3.5-flash-lite",
      modelPool: ["gemini-3.5-flash-lite", "gemini-3.8-flash"],
      baseUrl: "https://x.dev",
    },
  });

  // Mark model 1 as daily parked in quota
  const { loadQuota, saveQuota } = await import("../src/store.js");
  const q = await loadQuota(e);
  q["gemini-3.5-flash-lite"] = nextPacificMidnight();
  await saveQuota(e, q);

  // Now gemini-3.5-flash-lite is daily parked.
  // Now make keys busy on gemini-3.8-flash
  const h1 = pool[0];
  const h2 = pool[1];
  h1.inUse = true;
  h2.inUse = true;

  try {
    await assert.rejects(
      () => complete(e, twoModelCfg, payload),
      (err) => {
        assert.ok(err instanceof PoolExhausted, "got " + err.name);
        assert.ok(err.resetAt <= Date.now() + 65_000, `resetAt should be ~60s and NOT Pacific Midnight (${new Date(err.resetAt).toISOString()})`);
        return true;
      },
    );
  } finally {
    h1.inUse = false;
    h2.inUse = false;
    clearMinuteQuota();
    clearKeyPoolCache();
  }
});

done();