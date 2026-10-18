import { assert, t, done } from "./harness.mjs";
import {
  extractKeys,
  acquireKey,
  acquireKeyWithWait,
  getKeyPool,
  getKeyPoolStatus,
  clearKeyPoolCache,
  setStateFilePath,
} from "../src/keyPool.js";
import { nextPacificMidnight } from "../src/store.js";

setStateFilePath("./test-keys-state.json");

await t("extractKeys extracts comma or newline separated keys", () => {
  assert.deepEqual(extractKeys({ GEMINI_API_KEYS: "key111, key222\nkey333" }), [
    "key111",
    "key222",
    "key333",
  ]);
  assert.deepEqual(extractKeys({ GEMINI_API_KEY: "single_key" }), ["single_key"]);
});

await t("extractKeys extracts keys from braces {key1, key2} and quotes", () => {
  assert.deepEqual(extractKeys({ GEMINI_API_KEYS: "{apikey1 , apikey2 , apikey3}" }), [
    "apikey1",
    "apikey2",
    "apikey3",
  ]);
  assert.deepEqual(extractKeys({ GEMINI_API_KEYS: '{"keyA", "keyB"}' }), ["keyA", "keyB"]);
  assert.deepEqual(extractKeys({ GEMINI_API_KEYS: "['keyX', 'keyY']" }), ["keyX", "keyY"]);
});

await t("acquireKey rotates through keys round-robin", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_A, key_B, key_C" };

  const h1 = acquireKey(env);
  assert.equal(h1.key, "key_A");
  h1.release();

  const h2 = acquireKey(env);
  assert.equal(h2.key, "key_B");
  h2.release();

  const h3 = acquireKey(env);
  assert.equal(h3.key, "key_C");
  h3.release();

  const h4 = acquireKey(env);
  assert.equal(h4.key, "key_A", "wraps around to first key");
  h4.release();
});

await t("acquireKey skips in-use keys (concurrency lock)", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_1, key_2" };

  const h1 = acquireKey(env);
  assert.equal(h1.key, "key_1");

  // While h1 is still in use, next request must get key_2
  const h2 = acquireKey(env);
  assert.equal(h2.key, "key_2");

  // While both are in use, no key is available
  const h3 = acquireKey(env);
  assert.equal(h3, null);

  h1.release();
  const h4 = acquireKey(env);
  assert.equal(h4.key, "key_1", "key_1 becomes available once released");
  h4.release();
  h2.release();
});

await t("releasing with 429 RPM cools down key for 60 seconds", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_err, key_good" };

  const h1 = acquireKey(env);
  assert.equal(h1.key, "key_err");
  h1.release(new Error("Resource has been exhausted (rate limit)"));

  // Next call skips key_err because it is in 60s cooldown
  const h2 = acquireKey(env);
  assert.equal(h2.key, "key_good");
  h2.release();

  // Next call still skips key_err
  const h3 = acquireKey(env);
  assert.equal(h3.key, "key_good");
  h3.release();
});

await t("getKeyPoolStatus shows unmasked keys and real status", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "AIzaSy_test1, AIzaSy_test2" };
  const status = getKeyPoolStatus(env);
  assert.equal(status.length, 2);
  assert.equal(status[0].key, "AIzaSy_test1");
  assert.equal(status[0].status, "active");
});

await t("400 with 'API key not valid' auto-quarantines key immediately (disabled = true)", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "bad_key, ok_key" };

  const h = acquireKey(env);
  assert.equal(h.key, "bad_key");
  const err = new Error("API key not valid. Please pass a valid API key.");
  err.status = 400;
  h.release(err);

  const pool = getKeyPool(env);
  const badItem = pool.find((k) => k.key === "bad_key");
  assert.equal(badItem.disabled, true, "bad_key must be marked disabled");

  // Subsequent acquires must never return bad_key
  const next = acquireKey(env);
  assert.equal(next.key, "ok_key");
  next.release();
});

await t("429 rate limit only sets cooldown and NEVER disables key", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "busy_key" };

  const h = acquireKey(env);
  assert.equal(h.key, "busy_key");
  const err = new Error("Resource has been exhausted (rate limit)");
  err.status = 429;
  h.release(err);

  const pool = getKeyPool(env);
  const item = pool.find((k) => k.key === "busy_key");
  assert.equal(item.disabled, false, "429 must not disable key");
  assert.ok(item.rpmCooldownUntil > Date.now(), "429 must set rpmCooldownUntil");
});

await t("acquireKeyWithWait waits for busy key to be released", async () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "single_busy_key" };

  const h1 = acquireKey(env);
  assert.equal(h1.key, "single_busy_key");

  // Release h1 asynchronously after 100ms
  setTimeout(() => {
    h1.release();
  }, 100);

  const start = Date.now();
  const h2 = await acquireKeyWithWait(env, { maxWaitMs: 1500, pollIntervalMs: 50 });
  assert.ok(h2 !== null, "should acquire key after wait");
  assert.equal(h2.key, "single_busy_key");
  assert.ok(Date.now() - start >= 90, "should have waited for release");
  h2.release();
});

await t("per-model daily quota only cools down that specific model", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_per_model" };

  const h = acquireKey(env, { model: "gemini-3.8-flash" });
  assert.equal(h.key, "key_per_model");
  const err = new Error("Quota exceeded for quota metric: limit 20 per day");
  err.status = 429;
  err.name = "DailyQuotaError";
  err.model = "gemini-3.8-flash";
  h.release(err);

  // Key should NOT be available for gemini-3.8-flash
  const hFlash = acquireKey(env, { model: "gemini-3.8-flash" });
  assert.equal(hFlash, null, "gemini-3.8-flash must be cooling down for this key");

  // Key SHOULD be available for gemini-3.5-flash-lite
  const hLite = acquireKey(env, { model: "gemini-3.5-flash-lite" });
  assert.ok(hLite !== null, "gemini-3.5-flash-lite has separate quota and must be available");
  assert.equal(hLite.key, "key_per_model");
  hLite.release();
});

await t("recordKeyError sets resetAt = nextPacificMidnight or err.resetAt instead of 24h", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_midnight_test" };

  const h = acquireKey(env, { model: "gemini-2.5-pro" });
  const err = new Error("daily quota exceeded");
  err.status = 429;
  err.name = "DailyQuotaError";
  err.model = "gemini-2.5-pro";
  const customReset = Date.now() + 10_000_000;
  err.resetAt = customReset;
  h.release(err);

  const pool = getKeyPool(env);
  assert.equal(pool[0].modelRpdCooldown["gemini-2.5-pro"], customReset, "uses err.resetAt when provided");

  // Test fallback to nextPacificMidnight
  clearKeyPoolCache();
  const env2 = { GEMINI_API_KEYS: "key_midnight_test2" };
  const h2 = acquireKey(env2, { model: "gemini-2.5-pro" });
  const err2 = new Error("limit per day exceeded");
  err2.status = 429;
  h2.release(err2);

  const pool2 = getKeyPool(env2);
  assert.equal(pool2[0].modelRpdCooldown["gemini-2.5-pro"], nextPacificMidnight(), "falls back to nextPacificMidnight()");
});

await t("getKeyPoolStatus reflects rpm_cooldown for modelRpmCooldown", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_rpm_status_test" };

  const h = acquireKey(env, { model: "gemini-3.8-flash" });
  const err = new Error("Rate limit exceeded (minute)");
  err.status = 429;
  err.name = "MinuteQuotaError";
  err.model = "gemini-3.8-flash";
  h.release(err);

  const status = getKeyPoolStatus(env);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, "rpm_cooldown");
  assert.match(status[0].detail, /Minute limit cooldown \(\d+s left\)/);
});

await t("acquireKey preserves active modelRpdCooldown across UTC midnight date change and prunes expired entries", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_rollover_test" };
  const h = acquireKey(env);
  assert.equal(h.key, "key_rollover_test");
  h.release();

  const pool = getKeyPool(env);
  const now = Date.now();
  // Simulate stale yesterday date and mixed cooldowns
  pool[0].lastResetDay = "1970-01-01";
  pool[0].requestsToday = 42;
  pool[0].modelRpdCooldown = {
    "gemini-2.5-pro": now + 100_000, // active
    "gemini-3-flash": now - 100_000, // expired
  };
  pool[0].modelRpmCooldown = {
    "gemini-2.5-pro": now + 50_000,  // active
    "gemini-3-flash": now - 50_000,  // expired
  };

  // Next acquireKey triggers date rollover check
  const h2 = acquireKey(env, { model: "gemini-3-flash" });
  assert.ok(h2 !== null, "expired cooldown model should be available");
  h2.release();

  assert.equal(pool[0].requestsToday, 1, "requests counter reset on date rollover");
  assert.equal(pool[0].modelRpdCooldown["gemini-2.5-pro"], now + 100_000, "active daily cooldown must be preserved");
  assert.equal(pool[0].modelRpdCooldown["gemini-3-flash"], undefined, "expired daily cooldown must be pruned");
  assert.equal(pool[0].modelRpmCooldown["gemini-2.5-pro"], now + 50_000, "active minute cooldown must be preserved");
  assert.equal(pool[0].modelRpmCooldown["gemini-3-flash"], undefined, "expired minute cooldown must be pruned");
});

await t("recordKeyError redacts raw API key from item.lastError", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_redact_test" };
  const h = acquireKey(env);
  h.release(new Error("Failed request to https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSySecretRawKey9876"));

  const pool = getKeyPool(env);
  assert.ok(!pool[0].lastError.includes("AIzaSySecretRawKey9876"), "raw API key must not be stored in lastError");
  assert.ok(pool[0].lastError.includes("key=[REDACTED]"), "key query param must be replaced with [REDACTED]");
});

await t("recordKeyError redacts bare API key without key= prefix", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "AIzaSyBareKeySecret" };
  const h = acquireKey(env);
  h.release(new Error("Network failure sending payload for AIzaSyBareKeySecret to backend"));

  const pool = getKeyPool(env);
  assert.ok(!pool[0].lastError.includes("AIzaSyBareKeySecret"), "bare API key must not leak into lastError");
  assert.ok(pool[0].lastError.includes("[REDACTED]"), "bare API key must be replaced with [REDACTED]");
});

await t("recordKeyError recognises rpd as daily quota metric", () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_rpd_test" };
  const h = acquireKey(env, { model: "gemini-2.5-pro" });
  const err = new Error("Resource exhausted for metric: rpd limit reached");
  err.status = 429;
  h.release(err);

  const pool = getKeyPool(env);
  assert.equal(pool[0].modelRpdCooldown["gemini-2.5-pro"], nextPacificMidnight(), "rpd error triggers daily quota reset at Pacific midnight");
});

await t("acquireKeyWithWait waits and acquires busy key even under short budget (<500ms)", async () => {
  clearKeyPoolCache();
  const env = { GEMINI_API_KEYS: "key_concurrency_short_wait" };
  const h1 = acquireKey(env);
  assert.ok(h1 !== null);

  // Release h1 in 100ms
  setTimeout(() => {
    h1.release();
  }, 100);

  // Second request has short wait budget of 350ms (< 500ms)
  const t0 = Date.now();
  const h2 = await acquireKeyWithWait(env, { maxWaitMs: 350, pollIntervalMs: 50 });
  const elapsed = Date.now() - t0;

  assert.ok(h2 !== null, "should acquire key once released");
  assert.ok(elapsed >= 80, `waited for release, elapsed: ${elapsed}ms`);
  h2.release();
  clearKeyPoolCache();
});

import { unlinkSync } from "node:fs";
try { unlinkSync("./test-keys-state.json"); } catch {}
setStateFilePath(null);

done("keypool");

