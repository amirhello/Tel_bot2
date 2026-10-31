# 6 Personas, User-Scoped Mode & Admin User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 6 upgraded Persian personas, enable per-user persona selection via Telegram `/mode` inline buttons, and build a full User Management tab with blocking and mode-editing in the `/admin` dashboard on Node.js / WispByte.

**Architecture:** 
Personas are expanded to 6 distinct archetypes in `src/prompt.js`. A new `src/users.js` module handles user tracking, metadata upserting (`user:<userId>:meta`), user indexing (`users:index`), and blocklist management via `env.CONFIG` (`FileKV` in `data/store.json`). Telegram callback queries are routed in both `bot.js` (for 24/7 long-polling on WispByte) and `src/index.js` to process `/mode` inline selections, while `src/admin.js` exposes dedicated REST APIs (`/admin/api/users*`) and a dynamic User Management dashboard view.

**Tech Stack:** Node.js 18+ (ES modules), WispByte Container (500MB RAM, 1GB Disk, 35% CPU), `FileKV` local JSON storage, Telegram Bot API 10.3+.

**Spec:** `docs/superpowers/specs/2026-11-01-personas-and-user-management-spec.md`

## Global Constraints

- Zero third-party runtime dependencies (pure Node.js standard libraries: `node:http`, `node:fs`, `node:crypto`, `node:path`).
- Optimized for WispByte limits: memory footprint well under 500 MB RAM and CPU usage minimal (0ms regexes, zero unnecessary fetches).
- Strict backwards compatibility: existing 18 test suites must remain 100% green.
- All admin endpoints under `/admin/api/users*` must be protected by `isAuthed(req, env)`.
- Constant-time operations and sanitized inputs to prevent timing attacks and XSS.

## Review Focus

1. **Unset or Legacy Persona Fallback:** When a user has not explicitly set a persona or has an unrecognized mode in storage, the bot must seamlessly fall back to `cfg.mode` (default `"smart"`).
2. **Blocked User Enforcement:** A blocked user's message must never trigger an LLM inference call, voice synthesis, or consume API quota; it must be recorded in the archive with an appropriate reason.
3. **Long Polling & Webhook Callback Support:** Both the WispByte long-polling runner (`bot.js`) and webhook router (`src/index.js`) must process `callback_query` updates when inline buttons are tapped.
4. **Callback Query Expiration / Idempotency:** Telegram callback queries from old or double-tapped `/mode` buttons must be acknowledged safely with `answerCallbackQuery` and not crash if already answered.
5. **Bounded User Indexing on 1GB Disk:** `users:index` and user metadata fetches must be bounded (capped at 1000 users) so storage writes stay tiny (<100KB) and load instantly.

---

### Task 1: 6 Personas Expansion & Prompt Engine

**Files:**
- Modify: `src/prompt.js:10-56`
- Modify: `src/store.js:280-310`
- Test: `test/test-prompt-personas.mjs`

**Interfaces:**
- Consumes: `cfg` object from `src/store.js`.
- Produces: `MODES = ["psychologist", "friend", "smart", "rude", "wolf", "polite"]`, `DEFAULT_PERSONAS`, `MODE_LABELS`.

- [ ] **Step 1: Write the failing test**

Create `test/test-prompt-personas.mjs` verifying:
1. `MODES` contains all 6 modes: `psychologist`, `friend`, `smart`, `rude`, `wolf`, `polite`.
2. `MODE_LABELS` has readable labels for all 6.
3. `DEFAULT_PERSONAS` contains high-quality system prompts for each of the 6 personas.
4. `buildSystemPrompt` correctly selects persona prompt based on `cfg.mode` and handles fallback.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-prompt-personas.mjs`
Expected: FAIL because `psychologist`, `friend`, `wolf` are not yet in `MODES`.

- [ ] **Step 3: Implement 6 personas in `src/prompt.js` and update `src/store.js`**

1. In `src/prompt.js`:
   - Update `MODES = ["psychologist", "friend", "smart", "rude", "wolf", "polite"]`.
   - Update `MODE_LABELS` with Persian/English titles.
   - Define rich persona prompts in `DEFAULT_PERSONAS` for `psychologist`, `friend`, `wolf`, `smart`, `rude`, `polite`.
2. In `src/store.js`:
   - Ensure default config migration initializes and preserves all 6 personas in `DEFAULT_PERSONAS`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/test-prompt-personas.mjs`
Expected: PASS with 6 passing checks.

- [ ] **Step 5: Verify existing tests**

Run: `node test/test-prompt.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompt.js src/store.js test/test-prompt-personas.mjs
git commit -m "feat(personas): add 6 upgraded personas and update prompt engine"
```

---

### Task 2: User Persistence & Storage Module (`src/users.js`)

**Files:**
- Create: `src/users.js`
- Test: `test/test-users.mjs`

**Interfaces:**
- Consumes: `env.CONFIG` (`FileKV` or any KV interface).
- Produces:
  - `recordUserActivity(env, user, chat)`: updates metadata and index.
  - `getUser(env, userId)`: returns user metadata object.
  - `listUsers(env)`: returns array of user objects sorted by `lastSeen` descending.
  - `setUserMode(env, userId, mode)`: updates active persona for user.
  - `setUserBlocked(env, userId, blocked)`: sets ban status.
  - `resetUserSettings(env, userId)`: resets mode to default and unbans.
  - `isUserBlocked(env, userId)`: fast boolean lookup.

- [ ] **Step 1: Write the failing test**

Create `test/test-users.mjs` verifying:
1. `recordUserActivity` creates `user:<id>:meta` and appends `id` to `users:index`.
2. Subsequent calls increment `messageCount` and update `lastSeen`.
3. `listUsers` returns users ordered by most recent activity.
4. `setUserMode` updates both `user:<id>:mode` and the metadata object.
5. `setUserBlocked` sets `user:<id>:blocked` and `isUserBlocked` returns `true`.
6. `resetUserSettings` clears mode override and unblocks user.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-users.mjs`
Expected: FAIL with "Cannot find module 'src/users.js'".

- [ ] **Step 3: Implement `src/users.js`**

Implement `src/users.js` using `env.CONFIG` (`FileKV`):
- Index key: `users:index` (capped at 1000 IDs).
- Meta key: `user:<id>:meta`.
- Mode key: `user:<id>:mode`.
- Blocked key: `user:<id>:blocked`.
- All methods safely handle missing `env.CONFIG` or corrupted records with sensible defaults.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/test-users.mjs`
Expected: PASS with 6 passing checks.

- [ ] **Step 5: Commit**

```bash
git add src/users.js test/test-users.mjs
git commit -m "feat(users): add user activity tracking and metadata storage module"
```

---

### Task 3: Telegram Inline Keyboard & Callback Query Infrastructure

**Files:**
- Modify: `src/telegram.js:50-70`
- Modify: `src/trigger.js:20-60`
- Modify: `src/index.js:50-76`
- Modify: `bot.js:245-285`
- Test: `test/test-telegram-inline.mjs`

**Interfaces:**
- Consumes: Telegram Bot API HTTP endpoints.
- Produces:
  - `sendInlineKeyboard(token, chatId, text, buttons, replyTo, threadId)`
  - `answerCallbackQuery(token, callbackQueryId, text, showAlert)`
  - `editMessageText(token, chatId, messageId, text, replyMarkup)`
  - `isCommand` recognizing `mode` and `شخصیت`.
  - `bot.js` long-polling loop handling `update.callback_query`.
  - `setWebhook` including `"callback_query"` in `allowed_updates`.

- [ ] **Step 1: Write the failing test**

Create `test/test-telegram-inline.mjs` verifying:
1. `sendInlineKeyboard` sends correct Bot API payload with `reply_markup.inline_keyboard`.
2. `answerCallbackQuery` calls `answerCallbackQuery` method with query ID.
3. `editMessageText` calls `editMessageText` with target `chat_id` and `message_id`.
4. `isCommand` detects `/mode`, `/mode@SayyadBot`, `/شخصیت`.
5. `bot.js` polling URL includes `allowed_updates` with `callback_query`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-telegram-inline.mjs`
Expected: FAIL with missing functions in `src/telegram.js`.

- [ ] **Step 3: Implement Telegram inline and callback methods**

1. In `src/telegram.js`:
   - Add `sendInlineKeyboard`, `answerCallbackQuery`, `editMessageText`.
   - Update `setWebhook` to include `allowed_updates: ["message", "callback_query"]`.
2. In `src/trigger.js`:
   - Add `mode` and `شخصیت` to recognized commands.
3. In `bot.js`:
   - Update `getUpdates` URL with `allowed_updates=["message","callback_query"]`.
   - In update loop: if `update.callback_query`, call `processCallback(env, update.callback_query)`.
4. In `src/index.js`:
   - In `webhook(req, env, ctx)`: if `update?.callback_query`, route to `processCallback(env, update.callback_query)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/test-telegram-inline.mjs`
Expected: PASS with 5 passing checks.

- [ ] **Step 5: Commit**

```bash
git add src/telegram.js src/trigger.js src/index.js bot.js test/test-telegram-inline.mjs
git commit -m "feat(telegram): support inline keyboards and callback query handling in bot runner"
```

---

### Task 4: Answering Pipeline Integration (Per-User Mode & Block Enforcement)

**Files:**
- Modify: `src/answer.js:80-130, 310-395`
- Test: `test/test-user-mode-flow.mjs`

**Interfaces:**
- Consumes: `src/users.js` (`recordUserActivity`, `isUserBlocked`, `getUser`, `setUserMode`), `src/prompt.js`.
- Produces:
  - User activity recorded on incoming messages.
  - Blocked users silently dropped with archive reason `"user blocked by admin"`.
  - `/mode` and `/شخصیت` command displays 6 persona buttons.
  - `processCallback(env, callbackQuery)` handles `mode:<persona>` clicks.
  - `reply()` selects the persona from `user:<id>:mode` (or falls back to `cfg.mode`).

- [ ] **Step 1: Write the failing test**

Create `test/test-user-mode-flow.mjs` verifying:
1. Blocked user message is ignored and logged in archive with reason `"user blocked by admin"`.
2. `/mode` command responds with inline keyboard containing the 6 persona buttons.
3. Callback query `mode:wolf` sets user persona to `wolf` and confirms with edited message.
4. Subsequent prompt execution uses the persona prompt of `wolf` instead of global `cfg.mode`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-user-mode-flow.mjs`
Expected: FAIL because `/mode` handling and block checking are not wired in `src/answer.js`.

- [ ] **Step 3: Implement pipeline integration in `src/answer.js`**

1. In `processMessage(env, msg)`:
   - Call `recordUserActivity(env, msg.from, msg.chat)`.
   - Check `await isUserBlocked(env, msg.from?.id)`: if true, ignore message and archive with reason `"user blocked by admin"`.
2. Add `export async function processCallback(env, callbackQuery)`:
   - Parse `callbackQuery.data` (e.g. `mode:<persona>`).
   - If starting with `mode:`, validate persona in `MODES`.
   - Call `setUserMode(env, callbackQuery.from.id, mode)`.
   - Call `answerCallbackQuery(token, callbackQuery.id, "شخصیت شما با موفقیت تغییر کرد ✅")`.
   - Call `editMessageText` confirming the chosen persona.
3. In `reply(env, msg, cfg, trace)`:
   - If `cmd === "mode" || cmd === "شخصیت"`:
     Send inline keyboard with the 6 personas and return.
   - For regular messages:
     Fetch user's chosen mode from `getUser(env, msg.from.id)` or `env.CONFIG.get("user:" + msg.from.id + ":mode")`.
     If valid, override `effectiveCfg = { ...cfg, mode: userMode }` when assembling system prompt in `buildSystemPrompt(effectiveCfg, ...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/test-user-mode-flow.mjs`
Expected: PASS with 4 passing checks.

- [ ] **Step 5: Commit**

```bash
git add src/answer.js test/test-user-mode-flow.mjs
git commit -m "feat(answer): wire per-user mode selection, callbacks, and blocklist guard"
```

---

### Task 5: Admin Panel UI & User Management Endpoints (`src/admin.js`)

**Files:**
- Modify: `src/admin.js:200-800, 880-980`
- Test: `test/test-admin-users.mjs`

**Interfaces:**
- Consumes: `src/users.js` (`listUsers`, `setUserBlocked`, `setUserMode`, `resetUserSettings`).
- Produces:
  - Users tab and pane in Admin Dashboard HTML.
  - Endpoints:
    - `GET /admin/api/users`
    - `POST /admin/api/users/block`
    - `POST /admin/api/users/mode`
    - `POST /admin/api/users/reset`

- [ ] **Step 1: Write the failing test**

Create `test/test-admin-users.mjs` verifying:
1. `GET /admin/api/users` requires authentication (401 when unauthorized).
2. `GET /admin/api/users` returns list of users with interaction stats and persona.
3. `POST /admin/api/users/block` blocks/unblocks a user and returns updated user.
4. `POST /admin/api/users/mode` changes a user's persona mode.
5. `POST /admin/api/users/reset` resets user settings.
6. `renderDashboard()` includes the "Users" tab and container.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-admin-users.mjs`
Expected: FAIL with 404 for `/admin/api/users`.

- [ ] **Step 3: Implement User Management in `src/admin.js`**

1. In HTML template `DASH`:
   - Add `<div class="tab" data-pane="users">Users <span class="tag" id="usercount">0</span></div>` in tabs header.
   - Add `<div class="pane" id="pane-users">...</div>` with:
     - Search input to filter by name/username/ID.
     - Refresh button.
     - Users table / card list displaying User ID, Name/Username, First/Last seen, Message count, Persona dropdown selector, Block/Unblock toggle, and Reset button.
2. In client-side script in `DASH`:
   - Add `loadUsers()` fetching `/admin/api/users` and rendering user cards.
   - Add event handlers for block/unblock, mode change, and reset with instant toast feedback.
3. In `handleAdmin(req, env, path)`:
   - Handle `GET /admin/api/users` -> returns `listUsers(env)`.
   - Handle `POST /admin/api/users/block` -> calls `setUserBlocked(env, body.userId, body.blocked)`.
   - Handle `POST /admin/api/users/mode` -> calls `setUserMode(env, body.userId, body.mode)`.
   - Handle `POST /admin/api/users/reset` -> calls `resetUserSettings(env, body.userId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/test-admin-users.mjs`
Expected: PASS with 6 passing checks.

- [ ] **Step 5: Verify `test-admin.mjs` still passes**

Run: `node test/test-admin.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin.js test/test-admin-users.mjs
git commit -m "feat(admin): add Users management tab and REST endpoints"
```

---

### Task 6: End-to-End Build & Test Suite Verification

**Files:**
- Modify: `build.mjs` (if needed for new exports)
- Run: `node build.mjs`
- Test: `node test/run-all.mjs`

**Interfaces:**
- Produces: bundled and minified `dist/sayyad-worker.js`.

- [ ] **Step 1: Run project bundler**

Run: `node build.mjs`
Expected: Bundles clean without syntax or resolution errors.

- [ ] **Step 2: Run all test suites**

Run: `node test/run-all.mjs`
Expected: ALL test suites pass (original 18 + new test suites: prompt-personas, users, telegram-inline, user-mode-flow, admin-users).

- [ ] **Step 3: Review git status and diff**

Run: `git status`
Expected: Clean and expected set of modified/new files.

- [ ] **Step 4: Commit**

```bash
git add dist/sayyad-worker.js
git commit -m "chore(build): recompile worker bundle with personas and user management"
```
