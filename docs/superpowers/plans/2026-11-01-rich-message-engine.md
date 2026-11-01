# Telegram Bot API 10.3 Rich Message Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Overview
Transform all analytical, medium, and long bot responses into rich, interactive Telegram Bot API 10.3 messages. This includes:
1. Dynamic prompt engineering for all 6 personas in `src/prompt.js` guiding the LLM to output native `<h3>`, `<details><summary>`, `<table>`, `<blockquote expandable>`, `<tg-button>`, and `<footer>` without wrapping them in backticks (` ``` `), while keeping short conversational replies natural.
2. Beautifully formatted web search result citations (`appendSources`) with clickable source links/buttons and collapsible details.
3. Robust HTML tag auto-balancer in `src/text.js` to ensure unclosed tags from token-capped LLM outputs never cause Telegram 400 Bad Request.
4. Retry logic and long-message chunking for `sendRichMessage` in `src/telegram.js`.
5. Accurate admin panel trace UI in `src/admin.js` displaying `✨ Rich Message (Bot API 10.3)`.
6. 100% unit test coverage for all new rich message mechanics and verification across all 23+ test suites.

---

## File Structure & Responsibilities

- **`src/prompt.js`**: Update `BASE_RULES` with rich formatting grammar, clear instructions, concrete examples, and boundary rules (short chats stay plain, long/analytical answers use rich components).
- **`src/text.js`**:
  - Update `hasRichFormatting` to detect all Bot API 10.3 tags (`h3`, `footer`, `figure`, `tg-button`, `tg-button-row`, `table`, `details`, `blockquote`).
  - Implement `balanceHtmlTags(html)` to auto-close any unclosed HTML tags.
  - Enhance `mdToRichHtml` to preserve and clean native rich HTML tags and balance tags.
- **`src/telegram.js`**:
  - Add retry mechanism (1 retry with 1.5s delay) to `sendRichMessage`.
  - Add long rich message chunking so messages > 3800 chars are split gracefully across multiple rich messages.
- **`src/answer.js`**:
  - Enhance `appendSources(text, sources)` to render search citations as a beautiful `<details><summary>🌐 منابع جستجو (${count})</summary>...` with buttons or formatted links.
  - Integrate tag balancing and rich chunk delivery in `deliverTextReply`.
- **`src/admin.js`**:
  - Update log trace rendering to display `✨ Rich Message (Bot API 10.3)` when `it.trace.delivery.kind === "rich_message"`.
- **`test/test-rich-message.mjs`**: New unit test suite covering tag balancing, rich detection, markdown table/quote conversion, and source formatting.

---

## Tasks

### Task 1: HTML Tag Balancer & Enhanced Rich Text Processing (`src/text.js`)

**Files to modify:**
- `src/text.js`
- `test/test-rich-message.mjs` (create new test)

- [ ] **Step 1.1**: Write unit tests in `test/test-rich-message.mjs` testing:
  - `hasRichFormatting`: returns true for `<h3>`, `<details>`, `<tg-button>`, `<table>`, `<footer>`, `blockquote expandable`, and markdown tables. Returns false for plain text.
  - `balanceHtmlTags`: closes unclosed tags like `<table><tr><td>data`, `<details><summary>test</summary>content`, `<b>unclosed`, etc., ignoring self-closing tags like `<img>` or `<br>`.
  - `mdToRichHtml`: ensures tags are balanced, headers become `<h3>`, and markdown tables become `<table bordered striped>`.
- [ ] **Step 1.2**: Run `node test/test-rich-message.mjs` and confirm it fails (tests absent/unimplemented).
- [ ] **Step 1.3**: Implement `balanceHtmlTags(html)` and update `hasRichFormatting` and `mdToRichHtml` in `src/text.js`.
- [ ] **Step 1.4**: Run `node test/test-rich-message.mjs` and ensure all tests pass.

---

### Task 2: Beautiful Search Results Citations & Delivery Pipeline (`src/answer.js`)

**Files to modify:**
- `src/answer.js`
- `test/test-rich-message.mjs`

- [ ] **Step 2.1**: Write unit tests for `appendSources` in `test/test-rich-message.mjs`:
  - When sources exist, verify output contains `<details><summary>🌐 منابع معتبر جستجو (${sources.length})</summary>` with styled links / buttons.
  - When no sources exist, verify text is returned unchanged.
- [ ] **Step 2.2**: Update `appendSources` in `src/answer.js` to format search citations with a clean `<details><summary>` block and neat clickable buttons/links (`<tg-button type="url" style="primary" url="...">`).
- [ ] **Step 2.3**: In `deliverTextReply`, ensure `balanceHtmlTags` is applied to rich HTML before sending, and log `tgOut` accurately.
- [ ] **Step 2.4**: Run `node test/test-rich-message.mjs` and verify it passes.

---

### Task 3: Robust `sendRichMessage` with Retry & Chunking (`src/telegram.js`)

**Files to modify:**
- `src/telegram.js`
- `test/test-telegram-rich.mjs`

- [ ] **Step 3.1**: Write unit test in `test/test-telegram-rich.mjs` verifying:
  - `sendRichMessage` retries once upon network error before failing.
  - `sendRichLong` splits large rich HTML (>3800 chars) into valid chunks and delivers them.
- [ ] **Step 3.2**: Implement retry logic and chunking in `src/telegram.js`.
- [ ] **Step 3.3**: Run `node test/test-telegram-rich.mjs` and verify it passes.

---

### Task 4: Rich Formatting Rules in Prompt Engine (`src/prompt.js`)

**Files to modify:**
- `src/prompt.js`
- `test/test-prompt-personas.mjs`

- [ ] **Step 4.1**: Update `BASE_RULES` in `src/prompt.js` with comprehensive instructions:
  - When to keep it simple: Short greetings, one-liners, and casual quick questions remain plain and natural without forced widgets.
  - When to use Rich Formatting: Analytical, explanatory, comparative, or medium/long replies MUST use Bot API 10.3 formatting:
    - `<h3>عنوان بخش</h3>` for distinct headers.
    - `<table>...</table>` for comparisons, structured parameters, specs, or tables (strictly NO backtick code blocks for tables!).
    - `<details><summary>عنوان تاشو</summary>توضیحات تکمیلی</details>` for deep dives or long explanations.
    - `<blockquote expandable>نکته مهم</blockquote>` for key warnings or conclusions.
    - `<tg-button type="copy_text" text="...">کپی دستور یا متن</tg-button>` for code snippets, key quotes, or commands.
    - `<footer>پیام پایانی یا امضای ربات</footer>` at the end of structured answers.
  - Strict rule: Never wrap native HTML tags (`table`, `details`, `tg-button`, etc.) inside markdown code fences (` ``` `).
- [ ] **Step 4.2**: Run `node test/test-prompt-personas.mjs` to ensure prompt assembly works across all 6 personas.

---

### Task 5: Admin Panel UI Delivery Label (`src/admin.js`)

**Files to modify:**
- `src/admin.js`
- `test/test-admin.mjs`

- [ ] **Step 5.1**: In `src/admin.js` (around line 734 in `renderLogItem`), add handling for `it.trace.delivery.kind === "rich_message"`:
  ```js
  var dKind = it.trace.delivery.kind === "voice" ? "🎙️ Voice Audio File (WAV)"
            : it.trace.delivery.kind === "text_fallback" ? "⚠️ Text Fallback (Voice failed)"
            : it.trace.delivery.kind === "rich_message" ? "✨ Rich Message (Bot API 10.3)"
            : "💬 Standard Text";
  ```
- [ ] **Step 5.2**: Run `node test/test-admin.mjs` to ensure the admin template renders without regressions.

---

### Task 6: Full Verification, Build & Commit

- [ ] **Step 6.1**: Run `node test/run-all.mjs` across all test suites (target: 24+ test suites passing 100%).
- [ ] **Step 6.2**: Recompile production bundle via `node build.mjs` and confirm `dist/sayyad-worker.js` builds cleanly.
- [ ] **Step 6.3**: Review `git status` and `git diff` to ensure zero stray files.
- [ ] **Step 6.4**: Commit changes with message `feat: Bot API 10.3 rich message engine, smart formatting prompt, and beautiful search citations` and push to `origin main`.
