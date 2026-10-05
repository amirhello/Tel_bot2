import { assert, t, done, M } from "./harness.mjs";

const { buildSystemPrompt, buildUserContent, replyContext, normalizeConfig, DEFAULT_PERSONAS, MODES } = M;
const BOT = 777;

const cfg = (over = {}) => normalizeConfig({ personas: DEFAULT_PERSONAS, ...over }, DEFAULT_PERSONAS);

await t("the system prompt carries the rules, the persona and the admin's extra", () => {
  const p = buildSystemPrompt(cfg({ mode: "rude", extra: "همیشه فارسی جواب بده" }));
  assert.match(p, /تو «سید» هستی/);
  assert.match(p, /تیکه/, "the rude persona must be present");
  assert.match(p, /دستورهای اضافه‌ی مدیر:\nهمیشه فارسی جواب بده/);
  assert.equal(buildSystemPrompt(cfg({ extra: "   " })).includes("دستورهای اضافه"), false);
});

await t("switching mode swaps exactly one block", () => {
  const rude = buildSystemPrompt(cfg({ mode: "rude" }));
  const polite = buildSystemPrompt(cfg({ mode: "polite" }));
  assert.match(rude, /بی‌رحم/);
  assert.match(polite, /ادب/);
  assert.ok(!rude.includes("بی‌ادعا"), "the polite block must not leak into rude");
});

await t("all three modes build a prompt", () => {
  for (const mode of MODES) {
    const p = buildSystemPrompt(cfg({ mode }));
    assert.ok(p.length > 200, mode);
  }
});

await t("the reply target is labelled by who wrote it", () => {
  const other = replyContext({ reply_to_message: { text: "قیمت دلار چنده؟", from: { id: 42 } } }, BOT);
  assert.equal(other.text, "قیمت دلار چنده؟");
  assert.equal(other.fromBot, false);

  const mine = replyContext({ reply_to_message: { text: "جواب قبلی", from: { id: BOT } } }, BOT);
  assert.equal(mine.fromBot, true);

  assert.deepEqual(replyContext({}, BOT), { text: "", fromBot: false });
});

await t("a long reply is truncated before it reaches the prompt", () => {
  const { text } = replyContext({ reply_to_message: { text: "الف".repeat(9000), from: { id: 42 } } }, BOT);
  assert.ok(text.length <= 3001, `too long: ${text.length}`);
  assert.ok(text.endsWith("…"));
});

await t("context, media and the question keep their order", () => {
  const parts = buildUserContent({
    text: "سید این چی میگه؟",
    replyText: "من پول نمی‌دم",
    replyFromBot: false,
    media: [{ type: "image", mime: "image/jpeg", data: "AAA" }],
    note: "[own video 9.0 MB]",
  });
  assert.equal(parts.length, 4);
  assert.match(parts[0].text, /پیامی که کاربر به آن ریپلای کرده/);
  assert.equal(parts[1].type, "image");
  assert.match(parts[2].text, /9\.0 MB/);
  assert.match(parts[3].text, /> سید این چی میگه؟/);
});

await t("replying to Sayyad says so", () => {
  const parts = buildUserContent({ text: "بیشتر توضیح بده", replyText: "قبلی", replyFromBot: true });
  assert.match(parts[0].text, /پیام قبلی خودت/);
});

await t("a bare 'سید' is signalled as a nudge, not a question", () => {
  for (const spelling of ["سید", "سيّد", "سِــيــد"]) {
    const parts = buildUserContent({ text: spelling });
    assert.match(parts.at(-1).text, /هیچ درخواست مشخصی نکرده/);
  }
});

await t("an empty message says why it is empty", () => {
  assert.match(buildUserContent({ text: "" }).at(-1).text, /پیامی بدون متن/);
  assert.match(buildUserContent({ text: "", replyText: "چیزی" }).at(-1).text, /توضیحی اضافه نکرده/);
});

await t("a message with no media and no reply is a single part", () => {
  const parts = buildUserContent({ text: "قیمت دلار چنده؟" });
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /^پیام کاربر:/);
});

done();