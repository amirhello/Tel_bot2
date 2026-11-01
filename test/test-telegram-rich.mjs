import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRichHtml, balanceHtmlTags } from "../src/text.js";
import { sendRichMessage } from "../src/telegram.js";

test("splitRichHtml splits long rich HTML into valid balanced chunks", () => {
  const block1 = "<h3>عنوان ۱</h3><p>" + "متن اول ".repeat(300) + "</p>";
  const block2 = "<h3>عنوان ۲</h3><p>" + "متن دوم ".repeat(300) + "</p>";
  const fullHtml = `${block1}\n\n${block2}`;

  assert.ok(fullHtml.length > 3500, `Expected length > 3500, got ${fullHtml.length}`);
  const chunks = splitRichHtml(fullHtml, 3000);

  assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3800, `Chunk exceeds max limit: ${chunk.length}`);
    // Check that tags in chunk are balanced
    const rebalanced = balanceHtmlTags(chunk);
    assert.equal(chunk, rebalanced, "Chunk must be self-balanced");
  }
});

test("sendRichMessage handles payload and returns result", async () => {
  let callCount = 0;
  let didFailOnce = false;
  // Mock global fetch for this test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    if (!didFailOnce && body.rich_message?.html?.includes("FAIL_ONCE")) {
      didFailOnce = true;
      return {
        ok: false,
        status: 502,
        json: async () => ({ ok: false, error_code: 502, description: "Bad Gateway" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 12345, chat: { id: 999 } } }),
    };
  };

  try {
    // Normal call
    const res1 = await sendRichMessage("mock_token", 999, "<h3>سلام</h3>", 100);
    assert.ok(res1?.ok);
    assert.equal(res1.result.message_id, 12345);

    // Call that fails once and succeeds on retry
    const res2 = await sendRichMessage("mock_token", 999, "<h3>FAIL_ONCE</h3>", 100);
    assert.ok(res2?.ok, "Should succeed after retry");
    assert.equal(callCount, 3, "Expected 1 call for res1 + 2 calls for res2 (initial + retry)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
