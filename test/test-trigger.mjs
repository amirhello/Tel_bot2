import { assert, t, done, M } from "./harness.mjs";

const { shouldAnswer, isCommand, isSupportedChat, TRIGGER } = M;
const BOT = 777;

const group = (over) => ({ chat: { id: -1001, type: "supergroup" }, reply_to_message: undefined, ...over });

await t("the wake word triggers from anywhere in a group message", () => {
  assert.equal(TRIGGER, "سید");
  assert.equal(shouldAnswer(group({ text: "سید این چیه؟" }), BOT, "supergroup"), true);
  assert.equal(shouldAnswer(group({ text: "این چیه سید" }), BOT, "supergroup"), true);
  assert.equal(shouldAnswer(group({ text: "ببین سید یه چیزی دیدم" }), BOT, "supergroup"), true);
  assert.equal(shouldAnswer(group({ caption: "عکس رو ببین سید" }), BOT, "supergroup"), true);
});

await t("an Arabic-typed wake word still triggers", () => {
  assert.equal(shouldAnswer(group({ text: "سيّد چیه" }), BOT, "supergroup"), true);
  assert.equal(shouldAnswer(group({ text: "سِــيــد" }), BOT, "supergroup"), true);
});

await t("ordinary group chatter is ignored", () => {
  assert.equal(shouldAnswer(group({ text: "سلام بچه‌ها" }), BOT, "supergroup"), false);
  assert.equal(shouldAnswer(group({}), BOT, "supergroup"), false);
  assert.equal(shouldAnswer(group({ text: "سیب که سیب می‌فروشم" }), BOT, "supergroup"), false);
});

await t("matching is by substring, so names starting with سید count too", () => {
  // Documented consequence of "any message containing the word سید": a person named سیدر
  // will trigger the bot. Change this test if the trigger should become word-boundary aware.
  assert.equal(shouldAnswer(group({ text: "سیدر" }), BOT, "supergroup"), true);
});

await t("replying to Sayyad counts as addressing it", () => {
  assert.equal(shouldAnswer(group({ text: "بیشتر توضیح بده", reply_to_message: { from: { id: BOT } } }), BOT, "supergroup"), true);
  assert.equal(shouldAnswer(group({ text: "بیشتر توضیح بده", reply_to_message: { from: { id: 42 } } }), BOT, "supergroup"), false);
});

await t("private chats answer everything", () => {
  assert.equal(shouldAnswer(group({ text: "سلام" }), BOT, "private"), true);
  assert.equal(shouldAnswer(group({}), BOT, "private"), true);
});

await t("commands are recognised with and without a bot suffix", () => {
  for (const c of ["/start", "/start@sayyad_bot", "/HELP", "/ping@x"]) {
    assert.ok(isCommand(c), c);
  }
  assert.equal(isCommand("/start please"), "start");
  assert.equal(isCommand("سید /start"), null);
  assert.equal(isCommand(""), null);
});

await t("only chat types the bot can live in are accepted", () => {
  for (const type of ["private", "group", "supergroup"]) {
    assert.equal(isSupportedChat({ chat: { type } }), true, type);
  }
  assert.equal(isSupportedChat({ chat: { type: "channel" } }), false);
  assert.equal(isSupportedChat(null), false);
});

done();