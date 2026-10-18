import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";
import * as Admin from "../src/admin.js";
import * as Tools from "../src/tools.js";
import * as Answer from "../src/answer.js";
import { clearKeyPoolCache } from "../src/keyPool.js";
import worker from "../src/index.js";

const {
  renderDashboard,
  renderLogin,
  readPatch,
  isAuthed,
  signSecret,
  handleAdmin,
  resetLoginRateLimit,
  recordFailedLogin,
  failedLoginAttempts,
  timingSafeEqual,
  verifyPassword,
} = Admin;

const NOOP = { waitUntil() {} };

await t("the dashboard renders every tab, field and script target", () => {
  const d = renderDashboard();
  for (const pane of ["pane-settings", "pane-media", "pane-log"]) {
    assert.ok(d.includes(`id="${pane}"`), pane);
  }
  for (const tab of ["settings", "media", "log"]) {
    assert.ok(d.includes(`data-pane="${tab}"`), tab);
  }
  for (const id of [
    "enabled", "p_kind", "p_model", "p_thinking", "p_baseUrl", "modes",
    "p_polite", "p_smart", "p_rude", "p_extra", "p_maxTokens", "p_dailyCap",
    "save", "save2", "diag", "diagout", "toast", "toast2",
    "p_pool", "poolreset", "poolstat",
    "logrefresh", "loglist", "logcount", "logmeta", "s_req", "s_today", "s_rep", "s_err", "s_last",
    "m_image_on", "m_image_mb", "m_image_per", "m_video_on", "m_video_mb", "m_video_per",
    "m_audio_on", "m_audio_mb", "m_audio_per",
    "s_harassment", "s_hateSpeech", "s_sexuallyExplicit", "s_dangerous",
  ]) {
    assert.ok(d.includes(`id="${id}"`), `missing id ${id}`);
  }
  for (const m of d.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(d.includes(`id="${m[1]}"`), `script reads a missing id: ${m[1]}`);
  }
});

await t("no placeholders are left unreplaced", () => {
  const d = renderDashboard();
  for (const p of ["__MODES__", "__LABELS__", "__THINKING__", "__SAFETY__", "__MEDIAS__", "__LEVELS__"]) {
    assert.ok(!d.includes(p), p);
  }
  assert.ok(d.includes('"polite","smart","rude"'), "the mode list must be injected");
  assert.ok(d.includes("BLOCK_NONE"), "the safety levels must be injected");
  assert.ok(d.includes("minimal"), "the thinking levels must be injected");
  assert.equal((d.match(/<option value="BLOCK_NONE">/g) ?? []).length, 4, "one select per safety category");
});

await t("user-supplied text is never interpolated as HTML", () => {
  const d = renderDashboard();
  assert.match(d, /e\.textContent\s*=\s*text/, "the helper must write through textContent");
  assert.ok(!/innerHTML\s*=/.test(d.replace(/innerHTML\s*=\s*""/g, "")), "nothing may be assigned through innerHTML");
});

await t("the login page hides the dashboard and can carry an error", () => {
  const l = renderLogin();
  assert.ok(l.includes('type="password"'));
  assert.ok(!l.includes('id="modes"'));
  assert.ok(renderLogin("Wrong password.").includes("Wrong password."));
});

await t("the session cookie is an HMAC of the password", async () => {
  const sig = await signSecret("hunter2");
  assert.equal(await isAuthed({ headers: new Headers({ cookie: `sayyad_admin=${sig}` }) }, env()), true);
  assert.equal(await isAuthed({ headers: new Headers({ cookie: `sayyad_admin=${await signSecret("other")}` }) }, env()), false);
  assert.equal(await isAuthed({ headers: new Headers({ cookie: "sayyad_admin=junk" }) }, env()), false);
  assert.equal(await isAuthed({ headers: new Headers() }, env()), false);
  assert.equal(await isAuthed({ headers: new Headers() }, {}), false, "no password configured -> locked");
});

await t("readPatch keeps good input and drops everything else", () => {
  const p = readPatch({
    enabled: true,
    mode: "rude",
    thinking: "turbo",
    maxTokens: "2500",
    dailyCap: "0",
    extra: "  همیشه فارسی  ",
    provider: { kind: "openai", model: "m", baseUrl: "https://x/v1", secret: "nope" },
    media: { image: { enabled: false, maxMB: 2, maxPer: 3 }, video: { enabled: true, maxMB: 9, maxPer: 1 }, evil: {} },
    safety: { harassment: "BLOCK_ONLY_HIGH", dangerous: "DROP_TABLE" },
    "personas.rude": "تیکه‌دار",
    "personas.evil": "x",
    personasSmart: "y",
    schemaVersion: 99,
  });
  assert.equal(p.enabled, true);
  assert.equal(p.mode, "rude");
  assert.equal(p.thinking, undefined, "an unknown thinking level is dropped");
  assert.equal(p.provider.kind, "openai");
  assert.equal("secret" in p.provider, false);
  assert.deepEqual(p.media.image, { enabled: false, maxMB: 2, maxPer: 3 });
  assert.equal("evil" in p.media, false);
  assert.deepEqual(p.safety, { harassment: "BLOCK_ONLY_HIGH" }, "an unknown safety value is dropped");
  assert.deepEqual(p.personas, { rude: "تیکه‌دار" });
  assert.equal(p.schemaVersion, undefined, "the schema version is never client-controlled");
});

/* ---------------------------------------------------------------- routes */

const post = (path, body, headers = {}) =>
  handleAdmin(new Request("https://x.dev" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env(), path);

const get = (path, headers = {}) => handleAdmin(new Request("https://x.dev" + path, { headers }), env(), path);

await t("GET /admin shows the login page to a stranger and the panel to the admin", async () => {
  assert.ok((await (await get("/admin")).text()).includes('type="password"'));
  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  assert.ok((await (await get("/admin", { cookie })).text()).includes('id="modes"'));
});

await t("login sets a cookie and a wrong password does not", async () => {
  const bad = await post("/admin/api/login", { password: "nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);

  const good = await post("/admin/api/login", { password: "hunter2" });
  assert.equal(good.status, 303);
  assert.match(good.headers.get("set-cookie"), /HttpOnly/);
  assert.match(good.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(good.headers.get("set-cookie"), /Max-Age=2592000/);
});

await t("every data route refuses an unauthenticated caller", async () => {
  for (const path of ["/admin/api/state", "/admin/api/log"]) {
    assert.equal((await get(path)).status, 401, path);
  }
});

await t("state returns the whole config, including the new provider and media sections", async () => {
  const e = env();
  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  const res = await handleAdmin(new Request("https://x.dev/admin/api/state", { headers: { cookie } }), e, "/admin/api/state");
  const d = await res.json();
  assert.equal(d.config.schemaVersion, 3);
  assert.equal(d.config.provider.kind, "gemini");
  assert.ok(Array.isArray(d.config.provider.modelPool) && d.config.provider.modelPool.length > 1);
  assert.deepEqual(Object.keys(d.config.media).sort(), ["audio", "image", "video"]);
  assert.equal(d.config.safety.harassment, "BLOCK_NONE");
});

await t("the quota endpoint is password-protected and reports the parked models", async () => {
  const e = env({
    CONFIG: fakeKV({ "quota:v1": JSON.stringify({ "gemini-3.8-flash": 1790000000000 }) }),
  });
  const anon = await get("/admin/api/quota");
  assert.equal(anon.status, 401);

  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  const d = await (await handleAdmin(
    new Request("https://x.dev/admin/api/quota", { headers: { cookie } }),
    e,
    "/admin/api/quota",
  )).json();
  assert.equal(d.quota["gemini-3.8-flash"], 1790000000000);
});

await t("saving merges into the stored config and leaves the rest alone", async () => {
  const e = env();
  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  const post2 = (body) =>
    handleAdmin(new Request("https://x.dev/admin/api/state", {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }), e, "/admin/api/state");

  const a = await (await post2({ mode: "rude", maxTokens: 1111 })).json();
  assert.equal(a.ok, true);
  assert.equal(a.config.mode, "rude");
  assert.equal(a.config.maxTokens, 1111);

  const b = await (await post2({ provider: { model: "gemini-3.1-pro" } })).json();
  assert.equal(b.config.provider.model, "gemini-3.1-pro");
  assert.equal(b.config.mode, "rude", "a later partial save must not reset earlier fields");
  assert.equal(b.config.maxTokens, 1111);
  assert.equal(b.config.provider.kind, "gemini", "an omitted provider kind is preserved");
});

await t("the archive endpoint returns newest first", async () => {
  const e = env({
    CONFIG: fakeKV({
      "log:v1": JSON.stringify([{ m: 2, x: "دوم" }, { m: 1, x: "اول" }]),
    }),
  });
  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  const d = await (await handleAdmin(new Request("https://x.dev/admin/api/log", { headers: { cookie } }), e, "/admin/api/log")).json();
  assert.equal(d.count, 2);
  assert.equal(d.items[0].x, "دوم");
});

await t("an unknown admin path is left to the router", async () => {
  assert.equal(await handleAdmin(new Request("https://x.dev/admin/nope"), env(), "/admin/nope"), null);
});

/* ---------------------------------------------------------------- security & endpoints hardening */

await t("/admin/api/keys masks sensitive keys and refuses unauthenticated callers", async () => {
  const e = env({ GEMINI_API_KEYS: "AIzaSyABCDEF1234567890abcdef1234567890" });
  const anon = await get("/admin/api/keys");
  assert.equal(anon.status, 401);

  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  const res = await handleAdmin(new Request("https://x.dev/admin/api/keys", { headers: { cookie } }), e, "/admin/api/keys");
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.count >= 1);
  const first = data.keys[0];
  assert.equal(first.key, "AIzaSy...7890");
  assert.ok(!first.key.includes("1234567890abcdef"), "full raw key must never be exposed");
});

await t("login endpoint blocks brute force attacks after 5 failed attempts with 429", async () => {
  M.resetLoginRateLimit?.();
  const testIp = "203.0.113.42";
  const headers = { "x-forwarded-for": testIp };

  for (let i = 1; i <= 5; i++) {
    const res = await post("/admin/api/login", { password: `bad_${i}` }, headers);
    assert.equal(res.status, 401, `attempt ${i} must return 401`);
  }

  // 6th attempt from the same IP must be rate limited with 429
  const blocked = await post("/admin/api/login", { password: "hunter2" }, headers);
  assert.equal(blocked.status, 429, "6th attempt must be blocked with HTTP 429");
  assert.equal(blocked.headers.get("retry-after"), "300");

  // Different IP should still be allowed
  const other = await post("/admin/api/login", { password: "hunter2" }, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(other.status, 303, "different IP should not be blocked");
  M.resetLoginRateLimit?.();
});

await t("cookie flags include HttpOnly, SameSite=Strict, and Secure on HTTPS", async () => {
  // HTTPS request
  const httpsRes = await post("/admin/api/login", { password: "hunter2" });
  assert.equal(httpsRes.status, 303);
  const cookie = httpsRes.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);

  // Plain HTTP request
  const httpReq = new Request("http://localhost/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  const httpRes = await handleAdmin(httpReq, env(), "/admin/api/login");
  assert.equal(httpRes.status, 303);
  const httpCookie = httpRes.headers.get("set-cookie");
  assert.match(httpCookie, /HttpOnly/);
  assert.match(httpCookie, /SameSite=Strict/);
  assert.ok(!httpCookie.includes("Secure"), "Secure flag must be omitted on plain HTTP");
});

await t("webhook strictly requires valid x-telegram-bot-api-secret-token when ADMIN_PASSWORD is set", async () => {
  const e = env({ TELEGRAM_BOT_TOKEN: "123:TEST", ADMIN_PASSWORD: "hunter2" });
  const want = await Tools.signWebhookSecret("hunter2");

  // Missing secret header -> 403 Forbidden
  const noHeader = await worker.fetch(new Request("https://x.dev/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
  }), e, NOOP);
  assert.equal(noHeader.status, 403, "missing secret token must return 403");

  // Invalid secret header -> 403 Forbidden
  const badSecret = await worker.fetch(new Request("https://x.dev/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong_secret" },
    body: JSON.stringify({ update_id: 2, message: { text: "hi" } }),
  }), e, NOOP);
  assert.equal(badSecret.status, 403, "wrong secret token must return 403");

  // Valid secret header -> 200 OK
  const good = await worker.fetch(new Request("https://x.dev/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": want },
    body: JSON.stringify({ update_id: 3 }),
  }), e, NOOP);
  assert.equal(good.status, 200, "valid secret token must be accepted");
});

await t("/setup, /setup/reset, and /diag require admin authentication (401 when unauthorized)", async () => {
  const e = env({ ADMIN_PASSWORD: "hunter2", TELEGRAM_BOT_TOKEN: "123:TEST" });
  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;

  for (const path of ["/setup", "/setup/reset", "/diag"]) {
    // Stranger without auth -> 401
    const unauthed = await worker.fetch(new Request("https://x.dev" + path), e, NOOP);
    assert.equal(unauthed.status, 401, `${path} must return 401 for strangers`);

    // With valid admin cookie -> not 401
    const authed = await worker.fetch(new Request("https://x.dev" + path, { headers: { cookie } }), e, NOOP);
    assert.notEqual(authed.status, 401, `${path} must allow authenticated admin`);
  }
});

await t("timingSafeEqual and verifyPassword prevent timing attacks accurately", async () => {
  assert.equal(timingSafeEqual("correct_secret", "correct_secret"), true);
  assert.equal(timingSafeEqual("correct_secret", "wrong_secret"), false);
  assert.equal(timingSafeEqual("short", "longer_string"), false);
  assert.equal(timingSafeEqual(null, "str"), false);

  assert.equal(await verifyPassword("hunter2", "hunter2"), true);
  assert.equal(await verifyPassword("wrong", "hunter2"), false);
  assert.equal(await verifyPassword("", "hunter2"), false);
});

await t("/admin/api/keys masks short keys properly with prefix and asterisks", async () => {
  clearKeyPoolCache();
  const e = env({ GEMINI_API_KEYS: "shortkey, 1234567890abcdef" });
  const cookie = `sayyad_admin=${await signSecret("hunter2")}`;
  const res = await handleAdmin(new Request("https://x.dev/admin/api/keys", { headers: { cookie } }), e, "/admin/api/keys");
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.count, 2);
  // Short key (8 chars <= 10) must be masked with first 2 chars + "***"
  assert.equal(data.keys[0].key, "sh***");
  assert.ok(!data.keys[0].key.includes("rtkey"), "short key tail must not be exposed");
  // Long key (> 10 chars) must be masked with first 6 + "..." + last 4
  assert.equal(data.keys[1].key, "123456...cdef");

  // Also verify that lastError redacts key parameters if present
  const { getKeyPool } = await import("../src/keyPool.js");
  const pool = getKeyPool(e);
  pool[0].lastError = "Failed: https://endpoint?key=leakMeSecret12345";
  const res2 = await handleAdmin(new Request("https://x.dev/admin/api/keys", { headers: { cookie } }), e, "/admin/api/keys");
  const data2 = await res2.json();
  assert.ok(!data2.keys[0].lastError.includes("leakMeSecret12345"), "lastError in /admin/api/keys must redact key");
  assert.ok(data2.keys[0].lastError.includes("key=[REDACTED]"), "lastError must contain key=[REDACTED]");

  // Very short key (<= 2 chars) must be masked completely with "***" without exposing characters
  const eShort = env({ GEMINI_API_KEYS: "k, ab" });
  clearKeyPoolCache();
  const res3 = await handleAdmin(new Request("https://x.dev/admin/api/keys", { headers: { cookie } }), eShort, "/admin/api/keys");
  const data3 = await res3.json();
  assert.equal(data3.keys[0].key, "***");
  assert.equal(data3.keys[1].key, "***");

  clearKeyPoolCache();
});

await t("failedLoginAttempts periodic cleanup and size cap at 1000", async () => {
  resetLoginRateLimit();
  assert.equal(failedLoginAttempts.size, 0);

  // Seed 1005 entries: 50 expired (> RATE_LIMIT_WINDOW_MS ago) and 955 recent
  const now = Date.now();
  const oldTime = now - 6 * 60 * 1000; // 6 minutes ago (> 5m window)

  for (let i = 1; i <= 50; i++) {
    failedLoginAttempts.set(`10.0.0.${i}`, [oldTime]);
  }
  for (let i = 51; i <= 1005; i++) {
    failedLoginAttempts.set(`10.0.1.${i}`, [now]);
  }
  assert.equal(failedLoginAttempts.size, 1005);

  // Calling recordFailedLogin should trigger cleanup because size > 1000
  // Expired entries (50) should be removed, bringing size down to 955 + 1 = 956 <= 1000
  recordFailedLogin("10.0.2.1");
  assert.ok(failedLoginAttempts.size <= 1000, `size should be <= 1000, got ${failedLoginAttempts.size}`);
  assert.equal(failedLoginAttempts.has("10.0.0.1"), false, "expired entry should be cleaned");
  assert.equal(failedLoginAttempts.has("10.0.2.1"), true, "new entry should be recorded");

  // Now test hard cap when all entries are fresh (cannot be pruned by expiration)
  resetLoginRateLimit();
  for (let i = 1; i <= 1002; i++) {
    failedLoginAttempts.set(`192.168.1.${i}`, [now]);
  }
  assert.equal(failedLoginAttempts.size, 1002);

  recordFailedLogin("192.168.2.1");
  assert.equal(failedLoginAttempts.size, 1000, `size must be strictly capped at 1000, got ${failedLoginAttempts.size}`);
  // The oldest keys should have been evicted
  assert.equal(failedLoginAttempts.has("192.168.1.1"), false, "oldest key should be evicted");
  assert.equal(failedLoginAttempts.has("192.168.2.1"), true, "newest key should be present");

  // Test LRU recency refresh: when an older IP fails again, its recency is refreshed to tail,
  // preventing an active attacker from being evicted over older inactive IPs when size > 1000.
  resetLoginRateLimit();
  recordFailedLogin("target-attacker"); // inserted at step 0
  for (let i = 1; i <= 999; i++) {
    failedLoginAttempts.set(`192.168.0.${i}`, [now]);
  }
  assert.equal(failedLoginAttempts.size, 1000);

  // Attacker fails again: this MUST refresh attacker's position to tail
  recordFailedLogin("target-attacker");
  // Now map size is still 1000 (not > 1000). Add one more IP to trigger cap cleanup:
  recordFailedLogin("192.168.99.1");
  assert.equal(failedLoginAttempts.size, 1000);
  // target-attacker must NOT have been evicted! The least-recently-active 192.168.0.1 must be evicted.
  assert.equal(failedLoginAttempts.has("target-attacker"), true, "active attacker must be preserved by LRU order");
  assert.equal(failedLoginAttempts.has("192.168.0.1"), false, "least recently used entry should be evicted first");

  resetLoginRateLimit();
});

await t("serialize executes jobs in order and clears timeout timer", async () => {
  let clearedTimers = 0;
  const origClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    clearedTimers++;
    return origClearTimeout(id);
  };

  try {
    const order = [];
    const p1 = Answer.serialize("chat1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("job1");
      return 1;
    });
    const p2 = Answer.serialize("chat1", async () => {
      order.push("job2");
      return 2;
    });
    const p3 = Answer.serialize("chat2", async () => {
      order.push("chat2_job");
      return 3;
    });

    const results = await Promise.all([p1, p2, p3]);
    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(order[0], "chat2_job"); // chat2 not blocked by chat1's 20ms delay
    assert.equal(order[1], "job1");
    assert.equal(order[2], "job2"); // job2 waited for job1
    assert.ok(clearedTimers >= 3, `clearTimeout should be called for each job, got ${clearedTimers}`);
  } finally {
    globalThis.clearTimeout = origClearTimeout;
  }
});

await t("diagnostics accurately detects gemini credentials from GEMINI_API_KEYS pool or GEMINI_API_KEY", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "mock" }), { status: 200 });
  try {
    // Case 1: multi-key pool GEMINI_API_KEYS set
    const diagMulti = await Tools.diagnostics({
      GEMINI_API_KEYS: "AIzaSyTest1, AIzaSyTest2",
    });
    assert.equal(diagMulti.checks.credentials.gemini, "set");
    assert.equal(diagMulti.checks.credentials.openai, "missing");

    // Case 2: single key GEMINI_API_KEY set
    const diagSingle = await Tools.diagnostics({
      GEMINI_API_KEY: "AIzaSySingle",
    });
    assert.equal(diagSingle.checks.credentials.gemini, "set");

    // Case 3: neither set
    const diagNone = await Tools.diagnostics({});
    assert.equal(diagNone.checks.credentials.gemini, "missing");

    // Case 4: undefined env argument (defaults to {})
    const diagDefault = await Tools.diagnostics();
    assert.equal(diagDefault.checks.telegram, "TELEGRAM_BOT_TOKEN secret is missing");
  } finally {
    globalThis.fetch = origFetch;
  }
});

await t("bot.js startup banner references /admin/api/state and not /admin/api/stats", async () => {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync("bot.js", "utf8");
  assert.ok(code.includes("/admin/api/state"), "must link to /admin/api/state");
  assert.ok(!code.includes("/admin/api/stats"), "must not link to obsolete /admin/api/stats");
});

done();