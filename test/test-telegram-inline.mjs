import { assert, t, done } from "./harness.mjs";
import {
  sendInlineKeyboard,
  answerCallbackQuery,
  editMessageText,
} from "../src/telegram.js";
import { isCommand } from "../src/trigger.js";

// Mock fetch to intercept Telegram API calls
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const parsed = new URL(url);
  const method = parsed.pathname.split("/").pop();
  const body = opts?.body ? JSON.parse(opts.body) : null;
  calls.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }));
};

await t("sendInlineKeyboard sends correct Telegram payload", async () => {
  calls.length = 0;
  const keyboard = [
    [{ text: "Button 1", callback_data: "data1" }],
    [{ text: "Button 2", callback_data: "data2" }],
  ];
  await sendInlineKeyboard("token123", 42, "Choose an option:", keyboard, 999, 10);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].body.chat_id, 42);
  assert.equal(calls[0].body.text, "Choose an option:");
  assert.deepEqual(calls[0].body.reply_markup, { inline_keyboard: keyboard });
  assert.equal(calls[0].body.reply_parameters?.message_id, 999);
  assert.equal(calls[0].body.message_thread_id, 10);
});

await t("answerCallbackQuery calls answerCallbackQuery with query ID and text", async () => {
  calls.length = 0;
  await answerCallbackQuery("token123", "cb_query_456", "Saved successfully", false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "answerCallbackQuery");
  assert.equal(calls[0].body.callback_query_id, "cb_query_456");
  assert.equal(calls[0].body.text, "Saved successfully");
  assert.equal(calls[0].body.show_alert, false);
});

await t("editMessageText edits text and optional reply_markup", async () => {
  calls.length = 0;
  await editMessageText("token123", 42, 123, "Updated text", null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "editMessageText");
  assert.equal(calls[0].body.chat_id, 42);
  assert.equal(calls[0].body.message_id, 123);
  assert.equal(calls[0].body.text, "Updated text");
});

await t("isCommand recognizes /mode and /شخصیت with or without bot name", () => {
  assert.equal(isCommand("/mode", "sayyad_bot"), "mode");
  assert.equal(isCommand("/mode@sayyad_bot", "sayyad_bot"), "mode");
  assert.equal(isCommand("/MODE", "sayyad_bot"), "mode");
  assert.equal(isCommand("/شخصیت", "sayyad_bot"), "شخصیت");
  assert.equal(isCommand("/شخصیت@sayyad_bot", "sayyad_bot"), "شخصیت");
});

globalThis.fetch = originalFetch;
done();
