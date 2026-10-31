import { assert, t, done } from "./harness.mjs";
import { processMessage, processCallback } from "../src/answer.js";
import { setUserBlocked, setUserMode, getUser } from "../src/users.js";

// Mock environment
function createMockEnv() {
  const store = new Map();
  const sentMessages = [];
  const answeredCallbacks = [];
  const editedMessages = [];

  const mockTg = async (url, opts) => {
    const parsed = new URL(url);
    const method = parsed.pathname.split("/").pop();
    const body = opts?.body ? (typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body) : null;
    if (method === "sendMessage") {
      sentMessages.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + sentMessages.length } }));
    }
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    if (method === "editMessageText") {
      editedMessages.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    if (method === "getMe") {
      return new Response(JSON.stringify({ ok: true, result: { id: 777, username: "sayyad_bot" } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };

  return {
    TELEGRAM_BOT_TOKEN: "mock_token",
    GEMINI_API_KEY: "mock_gemini_key",
    sentMessages,
    answeredCallbacks,
    editedMessages,
    mockTg,
    CONFIG: {
      async get(key, type = "text") {
        const val = store.get(key);
        if (val === undefined || val === null) return null;
        if (type === "json") {
          try {
            return typeof val === "string" ? JSON.parse(val) : val;
          } catch {
            return null;
          }
        }
        return typeof val === "string" ? val : JSON.stringify(val);
      },
      async put(key, val) {
        store.set(key, typeof val === "string" ? val : JSON.stringify(val));
      },
      async delete(key) {
        store.delete(key);
      },
    },
  };
}

const originalFetch = globalThis.fetch;

await t("blocked user message is dropped and recorded with blocked reason", async () => {
  const env = createMockEnv();
  globalThis.fetch = env.mockTg;

  // Block user 999
  await setUserBlocked(env, 999, true);

  const msg = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 999, type: "private" },
    from: { id: 999, first_name: "BlockedUser", is_bot: false },
    text: "سلام سید",
  };

  await processMessage(env, msg);

  // No message should be sent to Telegram
  assert.equal(env.sentMessages.length, 0);

  // Check archive
  const archive = await env.CONFIG.get("log:v1", "json");
  assert.ok(Array.isArray(archive));
  assert.equal(archive.length, 1);
  assert.equal(archive[0].a, false, "message was not answered");
  assert.equal(archive[0].reason, "user blocked by admin");
});

await t("/mode command sends inline keyboard with 6 personas", async () => {
  const env = createMockEnv();
  globalThis.fetch = env.mockTg;

  const msg = {
    message_id: 2,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "ActiveUser", is_bot: false },
    text: "/mode",
  };

  await processMessage(env, msg);

  assert.equal(env.sentMessages.length, 1);
  const sent = env.sentMessages[0];
  assert.equal(sent.chat_id, 42);
  assert.match(sent.text, /انتخاب شخصیت سید/);
  assert.ok(sent.reply_markup?.inline_keyboard);
  const buttons = sent.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 6, "must have 6 buttons");
  assert.ok(buttons.some((b) => b.callback_data === "mode:psychologist"));
  assert.ok(buttons.some((b) => b.callback_data === "mode:wolf"));
});

await t("processCallback sets user persona and edits message", async () => {
  const env = createMockEnv();
  globalThis.fetch = env.mockTg;

  const cb = {
    id: "cb_123",
    from: { id: 42, first_name: "ActiveUser" },
    data: "mode:wolf",
    message: { chat: { id: 42 }, message_id: 200 },
  };

  await processCallback(env, cb);

  assert.equal(env.answeredCallbacks.length, 1);
  assert.equal(env.answeredCallbacks[0].callback_query_id, "cb_123");

  assert.equal(env.editedMessages.length, 1);
  assert.match(env.editedMessages[0].text, /گرگ بازار/);

  // Mode saved in KV
  const savedMode = await env.CONFIG.get("user:42:mode");
  assert.equal(savedMode, "wolf");
});

await t("subsequent message uses user chosen mode instead of global mode", async () => {
  const env = createMockEnv();
  let capturedSystemPrompt = "";
  // Intercept fetch to mock LLM call
  globalThis.fetch = async (url, opts) => {
    if (url.includes("generativelanguage.googleapis.com") || url.includes("openrouter.ai") || url.includes("/chat/completions")) {
      const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
      capturedSystemPrompt = body.systemInstruction?.parts?.[0]?.text || body.system_instruction?.parts?.[0]?.text || body.messages?.[0]?.content || "";
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "سلام گرگ بازار" }] } }] }));
    }
    return env.mockTg(url, opts);
  };

  // User 42 has mode: "wolf", global cfg is "smart"
  await setUserMode(env, 42, "wolf");

  const msg = {
    message_id: 10,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "ActiveUser", is_bot: false },
    text: "سلام سید، چه خبر؟",
  };

  await processMessage(env, msg);

  assert.match(capturedSystemPrompt, /گرگ بازار/);
  assert.ok(!capturedSystemPrompt.includes("دانای کل"), "must not use global smart mode when user chose wolf");
});

globalThis.fetch = originalFetch;
done();
