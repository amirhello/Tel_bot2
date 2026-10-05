import { assert, t, done, M, env, json, fakeKV } from "./harness.mjs";

const { renderDashboard, renderLogin, readPatch, isAuthed, signSecret, handleAdmin } = M;

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

done();