import { assert, t, done, M, env, json } from "./harness.mjs";

const { detectMedia, collectMedia, defaultConfig } = M;

let downloaded = 0;
let bytes = new Uint8Array(64).fill(9);

/** Replace global fetch so the Telegram file API is faked and counted. */
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/getFile")) return json({ ok: true, result: { file_path: "media/file_1.bin" } });
  if (u.includes("/file/bot")) {
    downloaded++;
    return new Response(bytes, { status: 200 });
  }
  return json({ ok: true, result: {} });
};

const cfg = (over = {}) => ({
  ...defaultConfig(M.DEFAULT_PERSONAS),
  ...over,
  media: { ...defaultConfig(M.DEFAULT_PERSONAS).media, ...(over.media ?? {}) },
});

const photo = (size = 1000) => ({ photo: [{ file_id: "p1", file_size: size }, { file_id: "p2", file_size: size }] });
const video = (size = 1000) => ({ video: { file_id: "v1", file_size: size, mime_type: "video/mp4" } });
const voice = (size = 1000) => ({ voice: { file_id: "a1", file_size: size, mime_type: "audio/ogg" } });

await t("each Telegram media kind maps to one neutral type", () => {
  assert.equal(detectMedia(photo(1)).type, "image");
  assert.equal(detectMedia(video(1)).type, "video");
  assert.equal(detectMedia({ video_note: { file_id: "n", file_size: 1 } }).type, "video");
  assert.equal(detectMedia({ animation: { file_id: "g", file_size: 1 } }).type, "video");
  assert.equal(detectMedia(voice(1)).type, "audio");
  assert.equal(detectMedia({ audio: { file_id: "x", file_size: 1 } }).type, "audio");
  assert.equal(detectMedia({ document: { mime_type: "image/png", file_size: 1 } }).type, "image");
  assert.equal(detectMedia({ sticker: {} }).type, "sticker");
  assert.equal(detectMedia({ document: { mime_type: "application/pdf", file_size: 1 } }).type, "file");
  assert.equal(detectMedia({ text: "hi" }), null);
  assert.equal(detectMedia(null), null);
});

await t("a photo comes back as base64 with its mime", async () => {
  bytes = new Uint8Array(32).fill(7);
  const { media, note } = await collectMedia(env(), { ...photo() }, cfg());
  assert.equal(media.length, 1);
  assert.equal(media[0].type, "image");
  assert.equal(media[0].mime, "image/jpeg");
  assert.equal(media[0].data, Buffer.from(bytes).toString("base64"));
  assert.equal(note, "");
});

await t("voice and video both reach the model as audio/video parts", async () => {
  const v = await collectMedia(env(), { ...voice() }, cfg());
  assert.equal(v.media[0].type, "audio");
  assert.equal(v.media[0].mime, "audio/ogg");

  const vd = await collectMedia(env(), { ...video() }, cfg());
  assert.equal(vd.media[0].type, "video");
  assert.equal(vd.media[0].mime, "video/mp4");
});

await t("a per-type switch turns that type off with a readable note", async () => {
  for (const [field, msg] of [["video", video()], ["audio", voice()], ["image", photo()]]) {
    const { media, note } = await collectMedia(env(), msg, cfg({ media: { [field]: { enabled: false, maxMB: 4, maxPer: 1 } } }));
    assert.equal(media.length, 0, field);
    assert.match(note, /turned off/, field);
  }
});

await t("an oversized file becomes a note, never a truncated upload", async () => {
  const { media, note } = await collectMedia(env(), video(9_000_000), cfg());
  assert.equal(media.length, 0);
  assert.match(note, /8\.6 MB — over the 4 MB limit/);
});

await t("the per-message cap is enforced per type", async () => {
  const both = { reply_to_message: { video: { file_id: "v1", file_size: 10, mime_type: "video/mp4" } }, ...video() };
  const { media, note } = await collectMedia(env(), both, cfg());
  assert.equal(media.length, 1, "only one video may pass");
  assert.match(note, /more than 1 video/);

  const twoImages = { reply_to_message: photo(10), ...photo(10) };
  const two = await collectMedia(env(), twoImages, cfg());
  assert.equal(two.media.length, 2, "two images are allowed by default");
});

await t("the replied-to message's media is collected before the message's own", async () => {
  const msg = { ...photo(10), reply_to_message: video(10) };
  const { media } = await collectMedia(env(), msg, cfg());
  assert.deepEqual(media.map((m) => m.type), ["video", "image"]);
});

await t("sticker, documents and download failures become notes", async () => {
  const s = await collectMedia(env(), { sticker: {} }, cfg());
  assert.match(s.note, /sticker/);

  const d = await collectMedia(env(), { document: { mime_type: "application/pdf", file_size: 5 } }, cfg());
  assert.match(d.note, /documents are not supported/);

  const real = globalThis.fetch;
  globalThis.fetch = async (u) =>
    String(u).endsWith("/getFile") ? json({ ok: true, result: { file_path: "f" } }) : new Response("nope", { status: 500 });
  const f = await collectMedia(env(), photo(10), cfg());
  globalThis.fetch = real;

  assert.equal(f.media.length, 0);
  assert.match(f.note, /could not be downloaded/);
});

await t("the file is downloaded once per accepted media item", async () => {
  downloaded = 0;
  await collectMedia(env(), { ...photo(), ...{ reply_to_message: video(10) } }, cfg());
  assert.equal(downloaded, 2);
});

await t("a text-only message produces no media and no note", async () => {
  const before = downloaded;
  const { media, note } = await collectMedia(env(), { text: "سلام" }, cfg());
  assert.deepEqual(media, []);
  assert.equal(note, "");
  assert.equal(downloaded, before, "a text-only message must not hit the file API");
});

done();