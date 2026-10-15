import { assert, t, done } from "./harness.mjs";
import {
  extractKeys,
  acquireKey,
  getKeyPool,
  getKeyPoolStatus,
  clearKeyPoolCache,
  setStateFilePath,
} from "../src/keyPool.js";

setStateFilePath("./test-keys-state.json");

await t("extractKeys extracts comma or newline separated keys", () => {
  assert.deepEqual(extractKeys({ GEMINI_API_KEYS: "key111, key222\nkey333" }), [
    "key111",
    "key222",
    "key333",
  ]);
  assert.deepEqual(extractKeys({ GEMINI_API_KEY: "single_key" }), ["single_key"]);
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

import { unlinkSync } from "node:fs";
try { unlinkSync("./test-keys-state.json"); } catch {}

done("keypool");
