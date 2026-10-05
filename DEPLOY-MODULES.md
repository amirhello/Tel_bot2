# استقرار ماژولار — راهنمای گام‌به‌گام

کد در ۱۶ ماژول جدا نوشته شده. در داشبورد کلودفلر هر ماژول یک فایل مستقل است و ماژول‌ها همدیگر را صدا می‌زنند.

> ⚠️ **اگر Worker فعلی آپ است، قبل از شروع این کار را بخوان.** گام صفر را رد نکن.

---

## گام صفر — بی‌خطر کردن وضعیت فعلی

Worker فعلی روی OpenRouter کار می‌کند (پاسخ `403` می‌گرفت، ولی کد و ساختار سالم است). ما ۱۶ ماژول را **جایگزین** می‌کنیم.

**قبل از شروع، این‌ها را یادداشت کن** تا اگر خواستی برگردی داشته باشی:

| چیز | از کجا |
|---|---|
| محتوای فعلی ویرایشگر | `Workers & Pages → sayyad-bot → Edit code → Ctrl+A → Ctrl+C` و در یک فایل متنی ذخیره کن |
| آدرس Worker | `sayyad-bot.workers.dev` |
| تنظیمات فعلی و پنل | کاربر و پرسونالیت‌ها داخل KV هستند و **با مهاجرت حفظ می‌شوند** |

---

## گام ۱ — ماژول‌ها را در تب Modules بساز

`Workers & Pages → sayyad-bot → Edit code → تب Modules → Add module`

برای هر ماژول:

- **Name** را دقیقاً مثل جدول زیر بنویس (حروف بزرگ/کوچک مهم است)
- محتوای فایل `src/<name>.js` را کامل کپی و داخلش بچسبان

> ترتیب ساختن مهم نیست — ولی **اول این ۱۵ تا را بساز**، بعد `index` را آخر.

| # | Name در داشبورد | فایلی که کپی می‌کنی |
|---|---|---|
| 1 | `text` | `src/text.js` |
| 2 | `store` | `src/store.js` |
| 3 | `http` | `src/http.js` |
| 4 | `trigger` | `src/trigger.js` |
| 5 | `prompt` | `src/prompt.js` |
| 6 | `telegram` | `src/telegram.js` |
| 7 | `archive` | `src/archive.js` |
| 8 | `media` | `src/media.js` |
| 9 | `providerOpenai` | `src/providerOpenai.js` |
| 10 | `providerGemini` | `src/providerGemini.js` |
| 11 | `llm` | `src/llm.js` |
| 12 | `answer` | `src/answer.js` |
| 13 | `voice` | `src/voice.js` |
| 14 | `admin` | `src/admin.js` |
| 15 | `tools` | `src/tools.js` |

### اگر قبلاً نسخه‌ی قبلی را نصب کرده‌ای

این ۳ تا را به‌روزرسانی کن (بقیه دست‌نخورده می‌مانند) و `voice` را **جدید** بساز:

```
answer.js   telegram.js   +   voice.js (جدید)
```

و بعد **Deploy** و یک بار `/setup` را باز کن.

**نکته:** خطوط `import { ... } from "name"` را **دست نزن** — اینها اسم ماژول‌هایی هستند که همین الان ساخته‌ای.

---

## گام ۲ — نقطه‌ی ورود

در تب اصلی ویرایشگر (جایی که کد اصلی بود)، **کل محتوای قبلی را پاک کن** و این را بچسبان:

```js
import { handleAdmin, json } from "admin";
import { processMessage } from "answer";
import { diagnostics, reportPage, resetWebhook, setup, signWebhookSecret } from "tools";

const seen = new Set();

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && req.method === "POST") return webhook(req, env, ctx);
    if (path === "/") return json({ ok: true, bot: "sayyad" });

    if (path === "/setup") {
      return json(await setup(req, env, url).catch((e) => ({ error: String(e?.message ?? e) })));
    }
    if (path === "/setup/reset") {
      return json(await resetWebhook(env).catch((e) => ({ error: String(e?.message ?? e) })));
    }
    if (path === "/diag") {
      const report = await diagnostics(env).catch((e) => ({ error: String(e?.message ?? e) }));
      if (url.searchParams.get("format") === "json") return json(report);
      return new Response(reportPage("Sayyad diagnostics", report), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path.startsWith("/admin")) {
      const handled = await handleAdmin(req, env, path).catch(() => json({ error: "internal" }, 500));
      if (handled) return handled;
    }
    return json({ error: "not found" }, 404);
  },
};

async function webhook(req, env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("TELEGRAM_BOT_TOKEN is not set", { status: 500 });
  if (env.ADMIN_PASSWORD) {
    const want = await signWebhookSecret(env.ADMIN_PASSWORD);
    if ((req.headers.get("x-telegram-bot-api-secret-token") ?? "") !== want) {
      return new Response("forbidden", { status: 403 });
    }
  }
  const update = await req.json().catch(() => null);
  if (update && typeof update.update_id === "number") {
    if (seen.has(update.update_id)) return new Response("ok");
    seen.add(update.update_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }
  if (update?.message) ctx.waitUntil(processMessage(env, update.message));
  return new Response("ok");
}
```

(این دقیقاً همان `src/index.js` است — اگر ترجیح می‌دهی، همان فایل را کپی کن.)

**Deploy** بزن.

---

## گام ۳ — متغیرها

`Settings → Variables and Secrets`

### حذف کن (دیگر لازم نیستند)
```
MODEL
API_BASE
REASONING_EFFORT
SEND_VIDEO
```
> مدل و آدرس حالا از پنل `/admin` خوانده می‌شوند، نه از متغیرها.

### نگه دار
| نام | Type | وضعیت |
|---|---|---|
| `DIAG_IMAGE` | Text | همان مقدار قبلی |
| `CONFIG` (KV binding) | Binding | همان |

### اضافه/به‌روزرسانی کن
| نام | Type | مقدار |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | همان توکن قبلی |
| `ADMIN_PASSWORD` | Secret | همان رمز قبلی |
| `GEMINI_API_KEY` | **Secret** | `YOUR_GEMINI_API_KEY` |
| `API_KEY` | **Secret** | کلید `sk-or-v1-...` اگر خواستی OpenRouter هم بماند |

> `GEMINI_API_KEY` حتماً **Secret** باشد، نه Text.

**Deploy** بزن.

---

## گام ۴ — وب‌هوک را دوباره ست کن

```
https://sayyad-bot.workers.dev/setup
```

**چرا لازم است:** کد جدید از یک کلید متفاوت برای `secret_token` استفاده می‌کند. بدون این، تلگرام ۴۰۳ می‌خورد.

> این کار پیام‌های در صف را پاک می‌کند. مشکلی نیست.

---

## گام ۵ — انتخاب سرویس از پنل

```
https://sayyad-bot.workers.dev/admin
```

**تب Settings → Provider:**

| فیلد | مقدار |
|---|---|
| Provider | `Gemini (native — video + audio)` |
| Model | `gemini-3.8-flash` |
| Thinking | `medium` |

**تب Settings → Model pool:** فهرست مدل‌ها، هر خط یکی، قوی‌ترین اول. پیش‌فرض همان است که از قبل پر شده. اگر نامی را اشتباه تایپ کنی، یک بار ۴۰۴ می‌گیرد و آن مدل تا فردا کنار گذاشته می‌شود.

زیر همین کادر، وضعیت مدل‌هایی که همین امروز تمام شده‌اند با ساعت برگشتشان نمایش داده می‌شود.

**تب Media & Safety:** عکس/ویدیو/صدا روشن باشند، چهار سطح ایمنی روی `BLOCK_NONE`.

**Save changes** را بزن.

> **Daily request cap** روی ۱۰۰۰ است (مجموع کل استخر، نه هر مدل). اگر قبلاً دستی روی عدد دیگری گذاشته‌اید، همان می‌ماند.

---

## گام ۶ — تست

```
https://sayyad-bot.workers.dev/diag
```

| خط | انتظار |
|---|---|
| `provider` | `"gemini"` |
| `model` | `"gemini-3.8-flash"` |
| `endpoint` | `.../models/gemini-3.8-flash:generateContent` |
| `checks.credentials.gemini` | `"set"` |
| `checks.model.ok` | **`true`** ← این مهم‌ترین خط است |

اگر `checks.model.ok` قرمز بود، **متن خطا را به من بده**. رایج‌ترین علت‌ها:

| خطا | معنی |
|---|---|
| `model pool exhausted` | امروز همه‌ی مدل‌ها تمام شده — تا نیمه‌شب به وقت پسیم صبح می‌شود |
| `403` / `non-JSON` | کلودفلر ترافیک Worker را بلاک می‌کند (قبلاً با OpenRouter هم همین شد) |
| `404 models/... not found` | اسم مدل در فهرست با چیزی که سرویس می‌شناسد نمی‌خواند |
| `400` | نام یا تنظیمات اشتباه |
| `401` | کلید Gemini اشتباه یا ناقص |
| `429` | سهمیه‌ی دقیقه‌ای تمام شده — چند دقیقه بعد امتحان کن |
| `live voice: ...` | جواب صوتی ساخته نشد — متن کامل را از Logs بگیر (در تلگرام فقط جمله‌ی خودمانی نشان داده می‌شود) |

---

## گام ۷ — تست در تلگرام

```
سید این چیه؟
```

بعد در گروه یک عکس بفرست و ریپلای کن:
```
سید این چیه؟
```
(می‌توانی از تب **Message log** ببینی که رکورد ثبت شده و برچسب `answered` دارد.)

بعد یک **ویس نوت** بفرست (در خصوصی همیشه، در گروه با کلمه‌ی «سید» یا ریپلای):

باید چند ثانیه بعد یک **فایل صوتی** به‌عنوان ریپلای بیاید — نه متن. اگر به‌جایش یکی از جمله‌های خطای خودمانی آمد، متن خطا را از تب **Workers & Pages → sayyad-bot → Logs** بگیر و بده (معمولاً `live voice: ...` است).

---

## اگر لازم شد برگردی

فایل متنی‌ای که در گام صفر ذخیره کردی را در ویرایشگر اصلی جایگزین کن، ماژول‌ها را پاک کن، **Deploy** بزن و `/setup` را باز کن.

تنظیمات و آرشیو در KV می‌مانند و با نسخه‌ی قبلی هم خوانده می‌شوند — چون کد قدیمی کلیدهای `config:v1` و `stats:v1` را می‌خواند.

---

## نگاشت ماژول به مسئولیت

| ماژول | مسئولیت | وابسته از |
|---|---|---|
| `text` | مارک‌داون، تکه‌بندی، نرمال‌سازی فارسی، base64 | — |
| `store` | KV، تنظیمات، مهاجرت v1، آمار | — |
| `http` | خطای API با وضعیت، POST مشترک | — |
| `trigger` | تصمیم جواب دادن + دستورها | `text` |
| `prompt` | سه شخصیت + ساخت پرامپت خنثی | `trigger` `text` |
| `telegram` | کلاینت Bot API + ارسال جواب | `text` |
| `archive` | آرشیو ۲۰۰ پیام | — |
| `media` | عکس/ویدیو/صدا → base64 خنثی | `telegram` `text` |
| `providerOpenai` | فرمت OpenAI: `image_url` / `video_url` / `input_audio` | `http` |
| `providerGemini` | فرمت Gemini: `inlineData` + `systemInstruction` + ایمنی | `http` `store` |
| `llm` | دیسپچر + fallback بین دو provider | `http` دو provider `store` |
| `answer` | خط لوله‌ی جواب + صف + سقف روزانه | ۷ ماژول بالا |
| `voice` | جواب صوتی: جلسه‌ی یک‌باره‌ی Live API + WAV | — (خوداتکا) |
| `admin` | مسیرها و HTML پنل | `archive` `prompt` `store` |
| `tools` | `/diag` و `/setup` | `llm` `prompt` `store` `telegram` `text` |
| `index` | مسیریابی | `admin` `answer` `tools` |