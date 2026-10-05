import { assert, t, done, M, fakeKV } from "./harness.mjs";

const { normalizeConfig, defaultConfig, migrateLegacy, loadConfig, saveConfig, bumpStats, loadStats, usedToday, todayKey } = M;
const personas = M.DEFAULT_PERSONAS;

await t("a fresh KV gets a complete, valid config", () => {
  const c = normalizeConfig(null, personas);
  assert.equal(c.schemaVersion, 3);
  assert.equal(c.enabled, true);
  assert.equal(c.provider.kind, "gemini");
  assert.equal(c.provider.model, "gemini-3.8-flash");
  assert.equal(c.thinking, "medium");
  assert.deepEqual(Object.keys(c.media).sort(), ["audio", "image", "video"]);
  assert.equal(c.safety.harassment, "BLOCK_NONE");
});

await t("an untouched daily cap of 50 follows the new default of 1000", async () => {
  const CONFIG = fakeKV({ "config:v2": JSON.stringify({ schemaVersion: 2, dailyCap: 50, mode: "rude" }) });
  const { config } = await loadConfig({ CONFIG }, personas);
  assert.equal(config.dailyCap, 1000, "a model pool needs a bigger ceiling");
  assert.equal(config.mode, "rude", "the admin's real choices are untouched");
  assert.equal(JSON.parse(CONFIG.store["config:v2"]).dailyCap, 1000, "and the new value is written back");
});

await t("a daily cap the admin actually chose is never second-guessed", async () => {
  const chosen = fakeKV({ "config:v2": JSON.stringify({ schemaVersion: 2, dailyCap: 60 }) });
  assert.equal((await loadConfig({ CONFIG: chosen }, personas)).config.dailyCap, 60);

  const current = fakeKV({ "config:v2": JSON.stringify({ schemaVersion: 3, dailyCap: 50 }) });
  assert.equal((await loadConfig({ CONFIG: current }, personas)).config.dailyCap, 50, "50 on the current schema means exactly that");
});

await t("bad values are repaired, not trusted", () => {
  const c = normalizeConfig(
    { mode: "drop-table", thinking: "turbo", maxTokens: 99999, dailyCap: -5, enabled: "yes",
      provider: { kind: "psychic", baseUrl: "https://x.dev///", model: 42 },
      safety: { harassment: "NOPE" },
      media: { image: { enabled: false, maxMB: 999, maxPer: 0 }, video: "not-an-object" } },
    personas,
  );
  assert.equal(c.mode, "smart");
  assert.equal(c.thinking, "medium");
  assert.equal(c.maxTokens, 8000);
  assert.equal(c.dailyCap, 1000, "a nonsense budget must fall back, never become 'unlimited'");
  assert.equal(c.enabled, true, "only an explicit false switches the bot off");
  assert.equal(normalizeConfig({ enabled: false }, personas).enabled, false);
  assert.equal(c.provider.kind, "gemini");
  assert.equal(c.provider.baseUrl, "https://x.dev");
  assert.equal(c.provider.model, "42");
  assert.equal(c.safety.harassment, "BLOCK_NONE", "an unknown safety value must fall back");
  assert.equal(c.media.image.enabled, false);
  assert.equal(c.media.image.maxMB, 19, "above the ceiling clamps");
  assert.equal(c.media.image.maxPer, 2, "below the floor falls back");
  assert.equal(c.media.video.maxMB, 4, "a broken media entry must fall back to defaults");
});

await t("personas are always all present and length-capped", () => {
  const c = normalizeConfig({ personas: { rude: "تیکه بزن", evil: "x" } }, personas);
  assert.equal(c.personas.rude, "تیکه بزن");
  assert.equal(c.personas.polite, personas.polite, "a missing persona must fall back");
  assert.equal("evil" in c.personas, false, "unknown personas must be dropped");
  const long = normalizeConfig({ personas: { smart: "x".repeat(9000) } }, personas);
  assert.ok(long.personas.smart.length <= 6000);
});

await t("a v1 record migrates and keeps the admin's existing choices", () => {
  const { config } = migrateLegacy(
    { enabled: false, mode: "rude", maxTokens: 900, dailyCap: 25, extra: "همیشه فارسی",
      videoCapMB: 6, personas: { rude: "تیکه‌دار" } },
    { requests: 5 },
    personas,
  );
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "rude");
  assert.equal(config.maxTokens, 900);
  assert.equal(config.dailyCap, 25);
  assert.equal(config.extra, "همیشه فارسی");
  assert.equal(config.media.video.maxMB, 6, "the old video cap becomes the new video cap");
  assert.equal(config.personas.rude, "تیکه‌دار");
  assert.equal(config.personas.polite, personas.polite);
  assert.equal(config.schemaVersion, 3);
});

await t("loadConfig migrates a v1 KV exactly once", async () => {
  const CONFIG = fakeKV({
    "config:v1": JSON.stringify({ mode: "polite", personas: { smart: "قدیمی" }, videoCapMB: 3 }),
    "stats:v1": JSON.stringify({ requests: 12, replies: 9 }),
  });
  const first = await loadConfig({ CONFIG }, personas);
  assert.equal(first.config.mode, "polite");
  assert.equal(first.config.personas.smart, "قدیمی");
  assert.equal(first.config.media.video.maxMB, 3);
  assert.equal(first.stats.requests, 12);

  assert.ok("config:v2" in CONFIG.store, "the migrated record is written to the new key");

  // second load must not re-migrate, and must be stable
  const second = await loadConfig({ CONFIG }, personas);
  assert.deepEqual(second.config, first.config);
});

await t("loadConfig on an empty KV just returns defaults", async () => {
  const { config, stats } = await loadConfig({ CONFIG: fakeKV() }, personas);
  assert.equal(config.mode, "smart");
  assert.equal(stats.requests, 0);
});

await t("a broken KV read degrades to defaults instead of throwing", async () => {
  const CONFIG = { get: () => Promise.reject(new Error("KV exploded")), put: async () => {} };
  const { config } = await loadConfig({ CONFIG }, personas);
  assert.equal(config.schemaVersion, 3);
});

await t("saveConfig normalises on the way in", async () => {
  const e = { CONFIG: fakeKV() };
  const saved = await saveConfig(e, { ...defaultConfig(personas), mode: "nope", maxTokens: 1e9 });
  assert.equal(saved.mode, "smart");
  assert.equal(saved.maxTokens, 8000);
  const again = await loadConfig(e, personas);
  assert.equal(again.config.maxTokens, 8000, "and stays normalised on the way out");
});

await t("the daily counter rolls over at the UTC date boundary", () => {
  const day = todayKey();
  assert.equal(usedToday({ day, today: 12 }), 12);
  assert.equal(usedToday({ day: "2000-01-01", today: 99 }), 0);
  assert.equal(usedToday({}), 0);
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
});

await t("bumpStats accumulates and resets", async () => {
  const e = { CONFIG: fakeKV({ "stats:v2": JSON.stringify({ day: "2000-01-01", today: 40, requests: 40 }) }) };
  const s = await bumpStats(e, { requests: 1, replies: 1 });
  assert.equal(s.today, 1);
  assert.equal(s.requests, 41);
  assert.equal(s.replies, 1);
  assert.equal(s.day, todayKey());
});

await t("bumpStats keeps the last error unless a new one arrives", async () => {
  const e = { CONFIG: fakeKV({ "stats:v2": JSON.stringify({ errors: 2, lastError: "boom" }) }) };
  assert.equal((await bumpStats(e, { requests: 1 })).lastError, "boom");
  assert.equal((await bumpStats(e, { lastError: "new" })).lastError, "new");
  assert.equal((await loadStats(e)).lastError, "new");
});

await t("a failing stats write never breaks the bot", async () => {
  const e = { CONFIG: { get: async () => null, put: async () => { throw new Error("quota"); } } };
  assert.doesNotReject(() => bumpStats(e, { requests: 1 }));
});

done();