import { assert, t, done, M, json } from "./harness.mjs";

const { callJson, ApiError, DEFAULT_BACKOFF, isShapeError, isCredentialError } = M;

const URL_ = "https://example.test/v1/thing";
const fast = { backoff: [5, 5] };

/** Install a responder and return a counter of how many times it ran. */
function withFetch(handler) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return handler(calls);
  };
  return () => calls;
}

await t("a clean response is returned after exactly one request", async () => {
  const calls = withFetch(() => json({ ok: 1 }));
  assert.deepEqual(await callJson(URL_, { headers: {}, body: {}, ...fast }), { ok: 1 });
  assert.equal(calls(), 1);
});

await t("a 503 is retried and a later success is returned", async () => {
  const calls = withFetch((n) => (n < 3 ? json({ error: { message: "high demand" } }, 503) : json({ ok: "recovered" })));
  const r = await callJson(URL_, { headers: {}, body: {}, ...fast });
  assert.deepEqual(r, { ok: "recovered" });
  assert.equal(calls(), 3, "two retries means at most three requests");
});

await t("after the retries run out the last error surfaces", async () => {
  const calls = withFetch(() => json({ error: { message: "still busy" } }, 503));
  await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, ...fast }), /503.*still busy/);
  assert.equal(calls(), 3);
});

await t("transient statuses are all retried, permanent ones are not", async () => {
  for (const status of [408, 429, 500, 502, 504]) {
    const calls = withFetch(() => json({ error: { message: "transient" } }, status));
    await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, ...fast }));
    assert.equal(calls(), 3, `status ${status} should be retried`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    const calls = withFetch(() => json({ error: { message: "permanent" } }, status));
    await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, ...fast }));
    assert.equal(calls(), 1, `status ${status} must not be retried`);
  }
});

await t("a network failure with no status is retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) throw new Error("socket hang up");
    return json({ ok: true });
  };
  assert.deepEqual(await callJson(URL_, { headers: {}, body: {}, ...fast }), { ok: true });
  assert.equal(calls, 2);
});

await t("an HTML block page reads as its real status and is not retried", async () => {
  const calls = withFetch(() => new Response("<html>just a moment</html>", { status: 403 }));
  await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, ...fast }), /non-JSON \(403\)/);
  assert.equal(calls(), 1, "a WAF block will not fix itself; do not hammer it");
});

await t("a 200 with an unparseable body still throws", async () => {
  withFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, ...fast }), /non-JSON \(200\)/);
});

await t("the pauses really happen, and the default is the one we ship", async () => {
  withFetch(() => json({ error: { message: "busy" } }, 503));
  const started = Date.now();
  await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, backoff: [120, 240] }));
  const waited = Date.now() - started;
  assert.ok(waited >= 340, `expected ~360ms of waiting, got ${waited}ms`);

  assert.deepEqual(DEFAULT_BACKOFF, [700, 2000]);
  // two pauses against the real default must stay well inside Workers' 30s waitUntil budget
  assert.ok(DEFAULT_BACKOFF.reduce((a, b) => a + b, 0) < 5000);
});

await t("retries can be switched off per call", async () => {
  const calls = withFetch(() => json({ error: { message: "busy" } }, 503));
  await assert.rejects(() => callJson(URL_, { headers: {}, body: {}, retries: 0 }));
  assert.equal(calls(), 1);
});

await t("error classification separates shape errors from missing credentials", () => {
  assert.equal(isShapeError(new ApiError("bad request shape", 400)), true);
  assert.equal(isShapeError(new ApiError("busy", 503)), false);
  assert.equal(isShapeError(new ApiError("API 503: high demand", 429)), false);

  assert.equal(isCredentialError(new ApiError("GEMINI_API_KEY secret is not set", 500)), true);
  assert.equal(isCredentialError(new ApiError("no API key secret is set (API_KEY or OPENROUTER_API_KEY)", 500)), true);
  assert.equal(isCredentialError(new ApiError("API 500: upstream exploded", 500)), false, "a plain 500 is not a key problem");
  assert.equal(isCredentialError(new ApiError("API 401: unauthorized", 401)), false);
});

done();