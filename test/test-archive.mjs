import { assert, t, done, M, env, fakeKV } from "./harness.mjs";

const { archiveRecord, mediaKind, readArchive, appendArchive, ARCHIVE_LIMIT } = M;

const read = async (e) => JSON.parse(e.CONFIG.store["log:v1"] ?? "[]");
const clear = (e) => delete e.CONFIG.store["log:v1"];

const msg = (over = {}) => ({
  message_id: 1,
  date: 1700000000,
  chat: { id: -1001, type: "supergroup", title: "رفیق‌ها" },
  from: { id: 42, is_bot: false, first_name: "رضا", username: "reza" },
  text: "سلام",
  ...over,
});

await t("a record carries who, where, when and the full text", () => {
  const r = archiveRecord(msg(), true);
  assert.equal(r.t, 1700000000000, "Telegram's own timestamp in ms");
  assert.deepEqual(r.u, { id: 42, name: "رضا" });
  assert.deepEqual(r.c, { id: -1001, t: "رفیق‌ها" });
  assert.equal(r.m, 1);
  assert.equal(r.x, "سلام");
  assert.equal(r.a, true);
});

await t("a missing timestamp falls back to now", () => {
  const before = Date.now();
  assert.ok(archiveRecord(msg({ date: undefined }), false).t >= before);
});

await t("a user with only a username still gets a name", () => {
  assert.equal(archiveRecord(msg({ from: { id: 7, username: "only_user" } }), false).u.name, "only_user");
  assert.equal(archiveRecord(msg({ from: { id: 7 } }), false).u.name, "7");
});

await t("a private chat has no title, so the type is the label", () => {
  const r = archiveRecord(msg({ chat: { id: 42, type: "private" } }), true);
  assert.equal(r.c.t, "private");
});

await t("a caption is used when there is no text", () => {
  assert.equal(archiveRecord({ ...msg(), text: undefined, caption: "توضیح" }, false).x, "توضیح");
});

await t("media is described, never stored", () => {
  assert.equal(mediaKind(msg()), "text only");
  assert.equal(mediaKind({ photo: [{}, {}] }), "photo");
  assert.equal(mediaKind({ video: {}, caption: "v" }), "video");
  assert.equal(mediaKind({ voice: {} }), "voice");
  assert.equal(mediaKind({ photo: [{}], video: {}, voice: {} }), "photo, video, voice");

  const r = archiveRecord({ ...msg(), photo: [{}, {}] }, false);
  assert.equal(r.k, "photo");
  assert.ok(!JSON.stringify(r).includes("base64"), "no payload may reach the archive");
});

await t("the archive keeps the newest first", async () => {
  const e = env();
  for (const id of [1, 2, 3]) await appendArchive(e, archiveRecord(msg({ message_id: id, text: "m" + id }), true));
  const log = await read(e);
  assert.deepEqual(log.map((r) => r.m), [3, 2, 1]);
});

await t("it caps at 200 and drops the oldest", async () => {
  const e = env();
  for (let i = 0; i < ARCHIVE_LIMIT + 5; i++) {
    await appendArchive(e, archiveRecord(msg({ message_id: i, text: "m" + i }), false));
  }
  const log = await read(e);
  assert.equal(log.length, ARCHIVE_LIMIT);
  assert.equal(log[0].m, ARCHIVE_LIMIT + 4);
  assert.equal(log.at(-1).m, 5);
});

await t("a broken archive read returns an empty list", async () => {
  assert.deepEqual(await readArchive(env({ CONFIG: { get: () => Promise.reject(new Error("boom")) } })), []);
  assert.deepEqual(await readArchive(env({ CONFIG: fakeKV({ "log:v1": "not-json" }) })), []);
});

await t("a failing write never breaks the bot", async () => {
  const e = env({ CONFIG: { get: async () => null, put: async () => { throw new Error("quota"); } } });
  await assert.doesNotReject(() => appendArchive(e, archiveRecord(msg(), true)));
});

await t("readArchive on an untouched namespace is empty", async () => {
  assert.deepEqual(await readArchive(env()), []);
  clear(env());
});

done();