import { assert, t, done, M } from "./harness.mjs";

const { mdToHtml, splitText, normalizeFa, toBase64, clampInt, truncate, preview, hasRichFormatting, isRtlText, mdToRichHtml } = M;

await t("mdToHtml renders bold, italic and inline code", () => {
  assert.equal(mdToHtml("سلام **دنیا** و *این*"), "سلام <b>دنیا</b> و <i>این</i>");
  assert.equal(mdToHtml("`<b>x</b>`"), "<code>&lt;b&gt;x&lt;/b&gt;</code>");
});

await t("mdToHtml escapes code exactly once", () => {
  assert.equal(mdToHtml("`<a> & <b>`"), "<code>&lt;a&gt; &amp; &lt;b&gt;</code>");
});

await t("mdToHtml lifts fenced blocks out of formatting", () => {
  assert.equal(mdToHtml("```js\nconst a = 1 < 2 && 3 > 2;\n```"), "<pre><code>const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>");
  assert.equal(mdToHtml("**b**\n```\ncode\n```\n**b2**"), "<b>b</b>\n<pre><code>code</code></pre>\n<b>b2</b>");
});

await t("mdToHtml never emits an unbalanced tag from unbalanced input", () => {
  for (const bad of ["**باز ** و `کد", "*a * b * c", "```\nunclosed", "<script>alert(1)</script>"]) {
    const html = mdToHtml(bad);
    const open = (html.match(/<b>/g) ?? []).length;
    const close = (html.match(/<\/b>/g) ?? []).length;
    assert.equal(open, close, `unbalanced bold in: ${bad}`);
    assert.ok(!/<script/i.test(html), "raw html must be escaped");
  }
});

await t("splitText keeps every chunk within the limit and loses nothing", () => {
  const long = Array.from({ length: 400 }, (_, i) => "خط " + i).join("\n");
  const parts = splitText(long, 500);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 500, `chunk too long: ${p.length}`);
  assert.equal(parts.join(" ").split(/\s+/).length, long.split(/\s+/).length);
});

await t("splitText prefers line breaks over word breaks", () => {
  const parts = splitText("a".repeat(600) + "\n" + "b".repeat(600), 800);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith("a"));
});

await t("splitText never returns an empty message", () => {
  assert.deepEqual(splitText("   "), [""]);
  assert.deepEqual(splitText("کوتاه"), ["کوتاه"]);
});

await t("splitText never splits a UTF-16 surrogate pair across chunks", () => {
  const str = "abcde" + "💖" + "fghi";
  const parts = splitText(str, 6);
  assert.equal(parts[0], "abcde");
  assert.equal(parts[1], "💖fghi");
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(i + 1 < part.length && part.charCodeAt(i + 1) >= 0xdc00 && part.charCodeAt(i + 1) <= 0xdfff, "lone high surrogate found");
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        assert.ok(i > 0 && part.charCodeAt(i - 1) >= 0xd800 && part.charCodeAt(i - 1) <= 0xdbff, "lone low surrogate found");
      }
    }
  }
});

await t("normalizeFa folds every spelling of the wake word", () => {
  for (const v of ["سید", "سيّد", "سِــيــد", "سيــد"]) {
    assert.ok(normalizeFa(v).includes("سید"), `no match: ${v}`);
  }
  assert.equal(normalizeFa("کیف کیف"), "کیف کیف");
});

await t("a ZWNJ next to the wake word does not hide it", () => {
  // Persian writes compounds with a ZWNJ; it must become a separator, not a silent miss.
  assert.ok(normalizeFa("سید‌علی").includes("سید"));
  assert.ok(normalizeFa("سلام سید‌علی").includes("سید"));
});

await t("toBase64 matches Buffer for chunk boundaries too", () => {
  for (const len of [0, 1, 3, 0x8000, 0x8000 + 7, 200000]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37) % 256;
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"), `len ${len}`);
  }
});

await t("clampInt guards admin input", () => {
  assert.equal(clampInt("abc", 200, 8000, 2000), 2000);
  assert.equal(clampInt(99999, 200, 8000, 2000), 8000);
  assert.equal(clampInt(-5, 1, 19, 4), 1);
  assert.equal(clampInt("5000", 200, 8000, 2000), 5000);
});

await t("truncate and preview keep text readable", () => {
  assert.equal(truncate("abcdef", 3), "abc…");
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(preview("a\n\n  b   c", 90), "a b c");
  assert.equal(preview("x".repeat(200), 10).length, 10);
});

await t("hasRichFormatting identifies markdown tables and rich telegram tags", () => {
  assert.equal(hasRichFormatting("متن ساده"), false);
  assert.equal(hasRichFormatting("| نام | قیمت |\n|---|---|\n| تتر | ۶۵ |"), true);
  assert.equal(hasRichFormatting("<table bordered striped><tr><td>x</td></tr></table>"), true);
  assert.equal(hasRichFormatting("<details><summary>بیشتر</summary>توضیحات</details>"), true);
  assert.equal(hasRichFormatting("<blockquote expandable>نقل قول</blockquote>"), true);
});

await t("mdToRichHtml converts tables and quotes to Telegram Bot API 10.3 tags", () => {
  const tableMd = "| شهر | دما |\n|---|---|\n| تهران | ۲۵ |";
  const rich = mdToRichHtml(tableMd);
  assert.ok(rich.includes("<table bordered striped>"));
  assert.ok(rich.includes("<th>شهر</th>"));
  assert.ok(rich.includes("<td>تهران</td>"));

  const quoteMd = "> این یک نقل قول است";
  const quoteRich = mdToRichHtml(quoteMd);
  assert.ok(quoteRich.includes("<blockquote expandable>"));
});

done();