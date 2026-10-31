import { assert, t, done, M, json } from "./harness.mjs";

const { extractSearchQuery, searchWeb } = M;

await t("extractSearchQuery cleans commands, wake words, and search phrases", () => {
  assert.equal(extractSearchQuery("/search نرخ دلار"), "نرخ دلار");
  assert.equal(extractSearchQuery("/google آب و هوا"), "آب و هوا");
  assert.equal(extractSearchQuery("/جستجو اخبار امروز"), "اخبار امروز");
  assert.equal(extractSearchQuery("سید قیمت طلا رو سرچ کن"), "قیمت طلا رو");
  assert.equal(extractSearchQuery("توی گوگل سرچ کن نتیجه فوتبال دیشب"), "نتیجه فوتبال دیشب");
  assert.equal(extractSearchQuery("سید"), "سید"); // short text fallback
});

await t("searchWeb handles empty or whitespace query safely", async () => {
  const r1 = await searchWeb("");
  assert.equal(r1.ok, false);
  const r2 = await searchWeb("   ");
  assert.equal(r2.ok, false);
});

await t("searchWeb parses DuckDuckGo HTML and returns grounded context and sources", async () => {
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <div class="result results_links">
          <h2 class="result__title">
            <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.tgju.org%2Fprofile%2Fprice_dollar_rl&amp;rut=1">قیمت دلار در شبکه اطلاع‌رسانی طلا و ارز</a>
          </h2>
          <a class="result__snippet" href="#">قیمت دلار امروز در بازار آزاد به 68500 تومان رسید.</a>
        </div>
        <div class="result results_links">
          <h2 class="result__title">
            <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbonbast.com%2F&amp;rut=2">صرافی بن‌بست</a>
          </h2>
          <a class="result__snippet" href="#">آخرین نرخ خرید و فروش ارز و طلا در صرافی بن‌بست.</a>
        </div>
      </body>
    </html>
  `;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes("duckduckgo.com"));
    return new Response(mockHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  try {
    const res = await searchWeb("قیمت دلار امروز");
    assert.equal(res.ok, true);
    assert.equal(res.sources.length, 2);
    assert.equal(res.sources[0].url, "https://www.tgju.org/profile/price_dollar_rl");
    assert.ok(res.sources[0].title.includes("طلا و ارز"));
    assert.ok(res.text.includes("68500"));
    assert.ok(res.text.includes("دستورالعمل"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

await t("searchWeb returns ok:false gracefully on fetch failure", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Connection failed");
  };

  try {
    const res = await searchWeb("قیمت بیت کوین");
    assert.equal(res.ok, false);
    assert.equal(res.sources.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

done("search");
