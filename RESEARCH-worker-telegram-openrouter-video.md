# Research: Telegram bot on Cloudflare Workers → OpenRouter (text + VIDEO, no ffmpeg)

Compiled 2026-09. All figures below are quoted/paraphrased from the cited sources.
Items that could NOT be verified are marked **[UNVERIFIED]**.

---

## 1) Cloudflare Workers hard limits

Source: https://developers.cloudflare.com/workers/platform/limits/ (page "Last updated Sep 5, 2026")

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| CPU time per HTTP request | **10 ms** | 5 min (default 30 s) |
| Memory | 128 MB | 128 MB |
| Subrequests / invocation | 50 | 10,000 (up to 10M) |
| Simultaneous open connections | 6 | 6 |
| Daily requests | 100,000/day | No limit |
| Worker size (uncompressed) | 64 MiB | 64 MiB |

**Wall clock (Duration)** — this is the critical one:
- **HTTP-triggered Workers: NO limit.** "There is no hard limit on duration for
  HTTP-triggered Workers. As long as the client remains connected, the Worker can
  continue processing, making subrequests, and streaming a response body."
- Cron / Queue / DO-alarm triggers: 15 min.
- `ctx.waitUntil()` can extend execution up to **30 seconds** after the response is sent.

**Request body size** — governed by the **Cloudflare account plan, NOT the Workers plan**:

| Cloudflare Plan | Max request body |
| --- | --- |
| Free | 100 MB |
| Pro | 100 MB |
| Business | 200 MB |
| Enterprise | up to 5 GB (self-serve) |

Response body size: no enforced limit. Exceeding the body limit → `413`.

**Is the CPU timer paused during `fetch()` I/O? — YES.** Verbatim:
> "CPU time measures how long the CPU spends executing your Worker code. Waiting on
> network requests (such as `fetch()` calls, KV reads, or database queries) does **not**
> count toward CPU time."

⇒ **Awaiting a slow HTTP response from OpenRouter does NOT consume the CPU budget.** The
slow part of the LLM round-trip is wall-clock, not CPU.

⚠️ **But base64-encoding a video IS CPU work** (it is JS computation, not I/O), as is
`JSON.stringify` of a multi-MB string and `arrayBuffer→base64` conversion. On the Free
plan's 10 ms CPU budget this is very likely to blow the limit. Budget it explicitly.

Notes:
- "Each isolate has some built-in flexibility… if your Worker starts hitting the limit
  consistently, its execution will be terminated." Exceeding CPU → **Error 1102**.
- 6-connection limit only counts connections **waiting for response headers**; once
  headers arrive a connection no longer counts. So sequential subrequests are fine.
- The average Worker uses ~2.2 ms CPU/request; "heavier workloads that … parse large
  payloads typically use 10–20 ms."
- Raising the limit (Paid only): `limits.cpu_ms` in wrangler config, or Dashboard →
  Workers & Pages → Settings. Default 30000, max 300000.

---

## 2) Getting VIDEO to an LLM on OpenRouter without ffmpeg

Source: https://openrouter.ai/docs/guides/overview/multimodal/videos

### Use `video_url`, NOT `type: "file"`

**Correct shape** (Chat Completions, `/api/v1/chat/completions`):
```
{ "type": "video_url", "video_url": { "url": "<url or data:video/mp4;base64,…>" } }
```
Verbatim: "You can send video files to compatible models through the
`/api/v1/chat/completions` API using the `video_url` content type. The `url` can be
either a URL or a base64-encoded data URL."

Base64 data URLs are explicitly documented and supported for locally stored videos.
So: Telegram `getFile` → download bytes → `data:video/mp4;base64,…` → `video_url`. **No
ffmpeg needed.**

**The `{"type":"file","file":{...}}` part is the PDF/file shape, not the video shape.**
Docs describe it as: "PDFs can be sent as direct URLs or base64-encoded data URLs in
the messages array, **via the file content type**" (https://openrouter.ai/docs/guides/overview/multimodal/pdfs).
It works for PDFs / documents, and the docs never show a `video/*` data URL in it.
⚠️ **[UNVERIFIED]** passing `data:video/mp4;base64,…` inside `type:"file"` is not
documented as supported. Use `video_url`.

### Supported video containers
`video/mp4`, `video/mpeg`, `video/mov`, `video/webm`.
Telegram's native `video` field is MPEG4 → **directly compatible**. If Telegram delivers
a `document` (other formats, e.g. MKV/AVI) it will NOT match and must be rejected or
transcoded — and there is no ffmpeg here.

### Provider caveats (important for routing)
- **Google Gemini on AI Studio: YouTube links ONLY** (not direct file URLs).
- **Google Gemini on Vertex AI: does NOT support video URLs** → must use base64 data URL.
- "OpenRouter only sends video URLs to providers that explicitly support them."
- `processing` field (`"agentic"` | `"static"`) is **Gemini-only**; other providers ignore it.
- The Messages API (`/api/v1/messages`) does **not** support video inputs.
- The Responses API (`/api/v1/responses`) uses part type `input_video`.

### Models with video input
Pulled live from `https://openrouter.ai/api/v1/models` (field
`architecture.input_modalities` contains `"video"`). ⚠️ The response was truncated by
the fetch tool at ~100 KB, so this is a **partial** list of the catalog — more exist.

Verified video-capable IDs:
- `google/gemini-3.8-flash` — text,image,video,file,audio
- `z-ai/glm-5.3-flash`, `z-ai/glm-5.3-flashx`, `~z-ai/glm-flash-latest` — text,image,video
- `qwen/qwen3.8-flash`, `qwen/qwen3.8-max-prime`, `qwen/qwen3.8-max-0902` — text,image,video
- `qwen/qwen3.8-omni-flash` — text,image,audio,video
- `xiaomi/mimo-v2.6-flash`, `xiaomi/mimo-v2.6-pro`, `xiaomi/mimo-v2.6-pro-ultraspeed` — text,image,video,audio
- `meta/muse-spark-1.3`, `meta/muse-spark-1.3-contributor`, `meta/muse-spark-1.2-contributor` — text,image,video,file,audio
- `inclusionai/ling-3.0-flash-vl` — text,image,video
- `perceptron/perceptron-mk1.5` — text,image,video,audio
- `typesafe/jev-router` — audio,file,image,text,video
- `stealth/space-bunny-alpha` — text,image,video

Note: there is **no "Qwen VL"** entry and **no Grok-4** entry in the fetched slice.
⚠️ **[UNVERIFIED]** for `x-ai/grok-*` video support and for the specific "Qwen VL"
model IDs the brief asked about — they may be in the truncated remainder of the catalog
or may not exist under those names. Check `input_modalities` on
`/api/v1/models` at runtime rather than hardcoding.

### Base64 size limits
⚠️ **[UNVERIFIED]** — OpenRouter publishes **no** maximum request-body size for base64
video in the chat completions docs. The docs only give qualitative advice ("Compress
videos… Trim videos… Consider using a video URL instead of base64 for large files").
The only hard byte limits published are on the Files API (below). The practical ceiling
in this architecture is Telegram's 20 MB download cap, and the 128 MB Workers memory cap.

### Files API (upload endpoint) — exists but is NOT a video path
Source: https://openrouter.ai/docs/guides/features/files-api (Beta)
- `POST /api/v1/files`, `multipart/form-data`, field name `file`. Returns id `or_file_…`.
- Max file size **100 MiB** (104,857,600 bytes) → `413` above that. Empty → `400`.
- Workspace storage cap 10 GiB total.
- **Accepted types (content-sniffed, not filename):** PDF, PNG/JPEG/GIF/WebP,
  DOCX/XLSX/PPTX, MP3/WAV/FLAC/OGG, UTF-8 text. Anything else → **400**.
  ⇒ **Video is rejected by the Files API.** It is not usable for this bot.
- Files never expire; uploaded files **cannot be downloaded back** (`GET …/content` → 400).
- Global endpoint only (`openrouter.ai`); in-region endpoints return 403.

### Rate limits
Source: https://openrouter.ai/docs/api_reference/limits
Free-model variants (`:free` suffix): **20 requests/minute**; **50/day** if <10 credits
ever purchased, **1000/day** at ≥10 credits. Paid variants have no platform cap.
429s also come from upstream providers (fallback routing may absorb them).

---

## 3) Telegram Bot API specifics

Source of truth: the Bot API spec JSON, **Bot API 10.3, release date August 24, 2026**
(mirror: https://raw.githubusercontent.com/PaulSonOfLars/telegram-bot-api-spec/main/api.json).
⚠️ `core.telegram.org` is DNS-blocked in this environment, so the official page could not
be fetched directly; the spec mirror is a faithful auto-generated copy of it.

### getFile / download
- Download URL: `https://api.telegram.org/file/bot<token>/<file_path>` (matches the
  architecture in the brief).
- **Max download size for bots: 20 MB.**
- The link is **guaranteed valid for at least 1 hour**; when it expires, call `getFile`
  again with the same `file_id` to get a fresh `file_path`. Pass `file_id`, **not**
  `file_unique_id`.
  (Text quoted from the Bot API `File` type, mirrored at
  https://gramio.dev/telegram/types/file)
- Corroborated by the official local-server README: self-hosted Bot API in `--local`
  mode "Download files without a size limit. Upload files up to 2000 MB" — implying the
  cloud limit exists. (https://raw.githubusercontent.com/tdlib/telegram-bot-api/master/README.md)
  A local server is not an option on Cloudflare Workers.
- Related: `sendVideo` allows bots to *send* up to **50 MB** (sending ≠ downloading).

### Webhook `secret_token` — supported
`setWebhook` field `secret_token`:
> "A secret token to be sent in a header `X-Telegram-Bot-Api-Secret-Token` in every
> webhook request, **1-256 characters**. Only characters **A-Z, a-z, 0-9, _ and -** are
> allowed."
⇒ Constrain generated secrets to that alphabet. Verify the header on every request;
a Workers bot is public, so this is the only thing authenticating the caller.

### `setWebhook` `allowed_updates` — supported
> "A JSON-serialized list of the update types you want your bot to receive. For example,
> specify `["message", "edited_channel_post", "callback_query"]`… Specify an **empty
> list to receive all update types except `chat_member`, `message_reaction`, and
> `message_reaction_count`** (default). If not specified, the previous setting will be
> used. Please note that this parameter **doesn't affect updates created before the
> call** to `setWebhook`, so unwanted updates may be received for a short period."

Other `setWebhook` params: `url` (HTTPS), `certificate`, `ip_address`,
`max_connections` (1–100, default 40), `drop_pending_updates`.

### Message send limits
- `sendMessage.text`: **"1-4096 characters after entities parsing"** (i.e. the limit
  applies post-parse, so raw text with markup can exceed 4096 and still be rejected).
  ⇒ split long model replies, and split on **UTF-16 code units** caution for Persian/emoji.
- `sendMessage.parse_mode`: "Mode for parsing entities in the message text."
- `entities`: a JSON-serialized `MessageEntity[]` **can be supplied instead of
  `parse_mode`** — this is the robust path for untrusted LLM output.

**Can `parse_mode: HTML` break on model output? — YES, and it will.**
If the text doesn't parse, the API returns **400 Bad Request: "can't parse entities: …"**
with parser-specific detail, e.g. `Unsupported start tag "br" at byte offset 10`,
`Can't find end of the entity starting at byte offset 42`. Any stray `<`, `>`, or `&`
that isn't valid Telegram HTML is a hard 400 — the message is not sent at all.
⇒ Escape all `<`/`>`/`&` before sending, or render to `entities[]`, or send as plain text
with no `parse_mode`. Never pass raw model output to `parse_mode` unescaped.

### `reply_parameters`
Accepted on `sendMessage`, `sendPhoto`, `sendVideo`, `sendDocument`, `sendMediaGroup`,
`sendAnimation`, `sendAudio`, `sendVoice`, `copyMessage`, `sendLocation`, `sendVenue`,
`sendPaidMedia`, `sendPoll`, `sendDice`, `sendContact`, `sendGame`, `sendInvoice`, etc.
Field description in the spec: "Description of the message to reply to."

`ReplyParameters` fields (per Bot API type):
`allow_sending_without_reply`, `chat_id`, `checklist_task_id`, `ephemeral_message_id`,
`message_id`, `poll_option_id`, `quote`, `quote_entities`, `quote_parse_mode`,
`quote_position`.
⇒ Minimum to reply to a specific message:
`reply_parameters: { "message_id": <update.message.message_id> }` (or `chat_id` +
`message_id` for cross-chat). `allow_sending_without_reply: true` avoids the error when
the target message is deleted. Use `quote_position` to control placement.

---

## 4) Persian text handling

Code points below were **verified computationally** (not copied from memory).

### "سید" (Sayyed) — 3 UTF-16 units, no ZWNJ
`U+0633 U+06CC U+062F`
- U+0633 ARABIC LETTER SEEN
- U+06CC ARABIC LETTER FARSI YEH ← **Persian yeh**
- U+062F ARABIC LETTER DAL

### The confusable pairs
| Character | Code point | Standard name |
| --- | --- | --- |
| ی yeh (Persian) | **U+06CC** | ARABIC LETTER FARSI YEH |
| ي yeh (Arabic) | **U+064A** | ARABIC LETTER YEH |
| ک keheh/kaf (Persian) | **U+06A9** | ARABIC LETTER KEHEH |
| ك kaf (Arabic) | **U+0643** | ARABIC LETTER KAF |
| ZWNJ | **U+200C** | ZERO WIDTH NON-JOINER |

(Also relevant: گ gaf is U+06AF, and Arabic/Persian heh variants are U+0647 vs U+06C0.)

### Normalization / matching implications
- **NFC and NFKC do NOT map U+064A → U+06CC, nor U+0643 → U+06A9.** They are distinct
  code points that remain distinct after normalization. ⇒ Matching a Persian trigger word
  like "سید" with `===` or `includes()` **fails** if the user typed the Arabic-form
  "سيد" (U+064A). You need an explicit fold step:
  U+064A→U+06CC, U+0643→U+06A9 (and optionally U+06CC→U+064A, U+06A9→U+0643 to a
  single canonical side), applied to **both** the trigger words and the incoming text.
- **ZWNJ (U+200C) is not removed by NFC/NFKC either** (it's Cf, format, and NFKC leaves
  it alone). Persian routinely writes compounds as می‌رود / کتاب‌ها with ZWNJ, and the same
  word is often typed without it (میرود / کتابها). ⇒ Explicitly **strip U+200C** (and
  optionally U+200E/U+200F LRM/RLM) before comparing. Otherwise half your users miss
  the trigger.
- Also normalize: Arabic-Indic vs Extended Arabic-Indic digits (U+0660–0669 vs U+06F0–06F9),
  Arabic vs Persian comma `،` U+060C, and Arabic semicolon `؛` U+061B.
- **Telegram delivers text as UTF-8 JSON in `message.text` with NO normalization applied**
  — whatever code points the user's keyboard produced reach the Worker as-is. Do not
  assume `message.text` is NFC.
- JS `String.prototype.normalize('NFKC')` exists in Workers; the yeh/kaf fold must be
  written by hand. `toLowerCase()` is a no-op for these letters (they have no case), so
  case-folding is not the problem — the yeh/kaf distinction is.

---

## Explicitly NOT verified

1. `{"type":"file"}` with a `data:video/mp4` payload — not documented; believed unsupported.
2. Any OpenRouter request-body size cap for base64 video — no published figure.
3. `x-ai/grok-*` video input and any "Qwen VL" model ID — absent from the fetched
   (truncated) catalog slice; re-check `/api/v1/models` at runtime.
4. The full video-capable model list — only ~20 found before the fetch truncated at 100 KB.
5. `core.telegram.org` could not be reached (DNS resolves to a non-public IP in this
   environment); all Telegram facts come from the Bot API 10.3 spec JSON mirror plus the
   tdlib README and a library mirror of the `File` type text.
6. Whether Cloudflare's 100 MB body cap is actually reachable through a Workers
   `fetch()` to OpenRouter — the doc states the account-plan limit, not an observed Worker behaviour.

## Environment caveats hit during this research
- `web_search` was unavailable (no `DEEPSEEK_API_KEY`); DuckDuckGo HTML endpoint used
  instead: `https://html.duckduckgo.com/html/?q=…`
- `r.jina.ai` returns HTTP 451 for core.telegram.org.
- PowerShell has **no outbound network** in this sandbox (TLS/connect failures), so live
  API calls must go through `web_fetch`.
- `core.telegram.org` / `telegram.org` are DNS-blocked.
