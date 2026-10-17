import { assert, t, done } from "./harness.mjs";
import { isRtlText, renderMarkdownTables, renderBlockquotes, mdToRichHtml } from "../src/text.js";
import { sendRichMessage, sendLong, sendText } from "../src/telegram.js";

await t("isRtlText detects Persian/Arabic scripts correctly", () => {
  assert.equal(isRtlText("سلام سید"), true);
  assert.equal(isRtlText("Hello world!"), false);
  assert.equal(isRtlText("12345"), false);
  assert.equal(isRtlText("Model: gemini (پاسخ فارسی)"), true);
});

await t("renderMarkdownTables transforms markdown tables to <table bordered striped>", () => {
  const md = "| ستون ۱ | ستون ۲ |\n| --- | --- |\n| داده ۱ | داده ۲ |";
  const html = renderMarkdownTables(md);
  assert.ok(html.includes("<table bordered striped>"));
  assert.ok(html.includes("<thead><tr><th>ستون ۱</th><th>ستون ۲</th></tr></thead>"));
  assert.ok(html.includes("<tbody><tr><td>داده ۱</td><td>داده ۲</td></tr></tbody>"));
  assert.ok(html.includes("</table>"));
});

await t("renderBlockquotes transforms > quotes to <blockquote expandable>", () => {
  const md = "> این یک نقل قول آزمایشی است\n> خط دوم نقل قول";
  const html = renderBlockquotes(md);
  assert.ok(html.includes("<blockquote expandable>"));
  assert.ok(html.includes("این یک نقل قول آزمایشی است\nخط دوم نقل قول"));
  assert.ok(html.includes("</blockquote>"));
});

await t("mdToRichHtml handles headers, buttons, tables, and footers with safe escaping", () => {
  const md = `### مشخصات مدل
این متن **بولد** و *ایتالیک* است.

| مورد | مقدار |
| --- | --- |
| سرعت | بالا |

<p>
  <tg-button type="copy_text" text="متن کپی">کپی</tg-button>
</p>
<script>alert(1)</script>`;

  const html = mdToRichHtml(md, { footer: "مدل: gemini-2.5-flash" });
  assert.ok(html.includes("<h3>مشخصات مدل</h3>"));
  assert.ok(html.includes("<b>بولد</b>"));
  assert.ok(html.includes("<i>ایتالیک</i>"));
  assert.ok(html.includes("<table bordered striped>"));
  assert.ok(html.includes('<tg-button type="copy_text" text="متن کپی">کپی</tg-button>'));
  assert.ok(html.includes("<footer>مدل: gemini-2.5-flash</footer>"));
  assert.ok(!html.includes("<script>"), "script tag must be escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

await t("sendRichMessage builds standard Telegram Bot API 10.3 payload", async () => {
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }));
  };

  try {
    const res = await sendRichMessage("test_token", 12345, "<h3>سلام</h3>", 888, true);
    assert.equal(res?.ok, true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.endsWith("/sendRichMessage"));
    assert.equal(sent[0].body.chat_id, 12345);
    assert.equal(sent[0].body.reply_parameters.message_id, 888);
    assert.deepEqual(sent[0].body.rich_message, {
      html: "<h3>سلام</h3>",
      is_rtl: true,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

await t("sendLong uses standard sendMessage directly without calling fake sendRichMessage", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/sendRichMessage")) {
      calls.push("sendRichMessage");
      return new Response(JSON.stringify({ ok: false, description: "404 Not Found" }), { status: 404 });
    }
    if (u.endsWith("/sendMessage")) {
      calls.push("sendMessage");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }));
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  try {
    await sendLong("token123", 555, "متن تستی با **بولد**", 777);
    assert.deepEqual(calls, ["sendMessage"], "Must call sendMessage directly without fake sendRichMessage");
  } finally {
    globalThis.fetch = origFetch;
  }
});

await t("sendText and sendLong forward message_thread_id to Telegram", async () => {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 200 } }));
  };

  try {
    await sendText("token123", 555, "سلام", 777, 42);
    assert.equal(bodies[0].message_thread_id, 42);

    await sendLong("token123", 555, "متن طولانی", 777, { message_thread_id: 99 });
    assert.equal(bodies[1].message_thread_id, 99);
  } finally {
    globalThis.fetch = origFetch;
  }
});

done("rich-message");
