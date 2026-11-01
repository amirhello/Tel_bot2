import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRichFormatting, balanceHtmlTags, mdToRichHtml } from "../src/text.js";
import { appendSources } from "../src/answer.js";

test("hasRichFormatting detects Bot API 10.3 elements and markdown tables", () => {
  assert.equal(hasRichFormatting("سلام سید چطوری؟"), false);
  assert.equal(hasRichFormatting("این یک متن معمولی با **بولد** و _ایتالیک_ است."), false);

  // Markdown table
  const mdTable = "| نام | سن |\n|---|---|\n| علی | ۲۵ |";
  assert.equal(hasRichFormatting(mdTable), true);

  // Native tags
  assert.equal(hasRichFormatting("<h3>عنوان بخش</h3>"), true);
  assert.equal(hasRichFormatting("<details><summary>جزئیات</summary>متن</details>"), true);
  assert.equal(hasRichFormatting("<tg-button type=\"url\" url=\"https://t.me\">لینک</tg-button>"), true);
  assert.equal(hasRichFormatting("<tg-button-row><tg-button>دکمه</tg-button></tg-button-row>"), true);
  assert.equal(hasRichFormatting("<table bordered striped><tr><td>داده</td></tr></table>"), true);
  assert.equal(hasRichFormatting("<blockquote expandable>نکته مهم</blockquote>"), true);
  assert.equal(hasRichFormatting("<footer>امضای ربات</footer>"), true);
  assert.equal(hasRichFormatting("<figure><img src=\"https://example.com/pic.jpg\"></figure>"), true);
});

test("balanceHtmlTags automatically closes unclosed HTML tags", () => {
  // Truncated table
  const truncatedTable = "<table bordered striped><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2";
  const balancedTable = balanceHtmlTags(truncatedTable);
  assert.ok(balancedTable.endsWith("</td></tr></tbody></table>"), `Expected closed tags at end, got: ${balancedTable}`);

  // Truncated details
  const truncatedDetails = "<details><summary>توضیحات بیشتر</summary>این یک متن خیلی طولانی است که ناگهان قطع ش";
  const balancedDetails = balanceHtmlTags(truncatedDetails);
  assert.ok(balancedDetails.endsWith("</details>"), `Expected </details> at end, got: ${balancedDetails}`);

  // Truncated quote and formatting
  const truncatedQuote = "<blockquote expandable><b>نکته مهم:</b> متن ناتمام";
  const balancedQuote = balanceHtmlTags(truncatedQuote);
  assert.ok(balancedQuote.endsWith("</blockquote>"), `Expected </blockquote> at end, got: ${balancedQuote}`);

  // Self closing tags should not be closed
  const withImg = "<figure><img src=\"https://example.com/test.jpg\"></figure>";
  assert.equal(balanceHtmlTags(withImg), withImg);

  // Already balanced HTML stays intact
  const valid = "<h3>عنوان</h3><p>متن</p><footer>پاورقی</footer>";
  assert.equal(balanceHtmlTags(valid), valid);
});

test("mdToRichHtml preserves rich tags and balances unclosed structures", () => {
  const input = "### عنوان بخش\n\n| مشخصه | مقدار |\n|---|---|\n| رم | ۱۶ گیگ |\n\n<details><summary>توضیحات</summary>ادامه دارد";
  const html = mdToRichHtml(input);

  assert.ok(html.includes("<h3>عنوان بخش</h3>"), "Must include <h3> header");
  assert.ok(html.includes("<table bordered striped>"), "Must convert markdown table");
  assert.ok(html.includes("<th>مشخصه</th>"), "Must render table headers");
  assert.ok(html.includes("<details><summary>توضیحات</summary>"), "Must preserve details");
  assert.ok(html.endsWith("</details>"), "Must balance unclosed details tag at the end");
});

test("appendSources renders beautiful search citations with expandable details and links", () => {
  const text = "پایتخت فرانسه پاریس است.";
  const sources = [
    { title: "ویکی‌پدیا پاریس", url: "https://fa.wikipedia.org/wiki/Paris" },
    { title: "دانشنامه بریتانیکا", url: "https://britannica.com/place/Paris" },
  ];

  const withSources = appendSources(text, sources);
  assert.ok(withSources.includes("پایتخت فرانسه پاریس است."));
  assert.ok(withSources.includes("<details><summary>🌐 منابع معتبر جستجو (۲)</summary>"));
  assert.ok(withSources.includes("fa.wikipedia.org"));
  assert.ok(withSources.includes("دانشنامه بریتانیکا"));
  assert.ok(withSources.includes("</details>"));

  // Empty sources returns unchanged text
  assert.equal(appendSources("سلام", []), "سلام");
  assert.equal(appendSources("سلام", null), "سلام");
});
