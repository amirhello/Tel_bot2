# Sayyad Bot "Zero-Error Guaranteed Response" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the bot into a 100% resilient, zero-failure engine: NEVER send error messages or timeouts to the user; continuously rotate through all 25+ API keys and tiered models with typing heartbeats until a complete, valid answer is delivered.

**Architecture:**
- **Zero-Error Guarantee:** Never abort with "الان یه کم درگیرم" or "سقف درخواست پر شد". Keep trying across keys and models until success.
- **Continuous Key Rotation:** 25 keys * 15 RPM = 375 RPM capacity. If all keys momentarily reach per-minute limits, wait in 2.5s sliding intervals with live typing indicator instead of failing.
- **Modality-Aware Model Tiers:**
  - *Multimedia (Voice/Video/Photo):* `gemini-3.5-flash-lite` -> `gemini-3.8-flash` -> `gemini-3.7-flash` -> `gemini-3.6-flash` -> `gemini-3-flash` -> `gemini-2.5-flash` -> `gemini-3.1-flash-lite`.
  - *Text:* All of the above PLUS `Antigravity` (100 RPD) PLUS `gemma-4-26b` & `gemma-4-31b` (14,400 RPD each - infinite text backup).
  - *Voice Output:* `gemini-3.8-live` (Unlimited RPM/RPD).
- **Keep-Alive Typing Heartbeat:** Send Telegram `typing` action every 4 seconds while rotating, keeping the chat active and user informed without timeouts.
- **Fast Invalid Key Quarantine:** Any 400 Invalid Key is quarantined in <50ms and the next key is tried seamlessly.

**Tech Stack:** Node.js 18+ (ESM, `node:http`, `node:crypto`, `node:fs/promises`, `WebSocket`), Telegram Bot API 7.x/8.x.

## Global Constraints
- **ZERO CODE CHANGES UNTIL HUMAN APPROVAL**: The user commanded "کد نزن تا نگفتم".
- **NEVER GIT PUSH WITHOUT EXPLICIT PERMISSION**: The user warned "کی به تو گفت پوش کنی روی گیت هاب".
- **NEVER SEND PREMATURE ERROR NOTICES**: Do not give up at 24s. Keep rotating keys and models until an answer is secured.
- **ZERO EXTERNAL DEPENDENCIES**: Maintain pure zero-dependency Node.js architecture.
- **100% PASSING TEST SUITES**: All tests in `test/run-all.mjs` must pass.

---

### Task 1: "Never-Give-Up" Resilient Key Acquisition & Multi-Key Loop (BUG-01, BUG-02, ZERO-ERR-01)

**Files:**
- Modify: `src/keyPool.js:150-250`
- Modify: `src/llm.js:40-120`
- Test: `test/test-keypool.mjs`, `test/test-llm.mjs`

**Interfaces:**
- `acquireKeyWithWait(env, { model, maxWaitMs = 15000, onWait })`: If all keys are currently in short RPM/busy cooldown, waits in short increments (e.g. 1.5s) with `onWait` callback (for typing pulse) until the earliest cooldown expires, rather than immediately returning null and failing.
- `runGeminiPool(env, cfg, payload, { onHeartbeat })`: Tries all available keys. If key gets 429, marks only that key, moves immediately to next key. If model hits 404/Unknown, drops model. Continues across models and keys until answer is obtained.

- [ ] **Step 1: Write test for continuous key failover on 429**
  - Verify that when Key 1 through Key 5 return 429, loop continues seamlessly to Key 6 without returning error or parking the model for healthy keys.
- [ ] **Step 2: Implement wait queue / adaptive wait in `src/keyPool.js`**
  - If all keys are in cooldown, calculate lowest remaining cooldown (e.g., 2s) and wait instead of returning null.
- [ ] **Step 3: Decouple 429 model parking in `src/llm.js`**
  - Never park a model in `quota[model]` unless ALL keys in the pool have returned quota errors for that model.
- [ ] **Step 4: Auto-quarantine invalid 400 keys in <50ms**
  - Immediately flag `item.disabled = true` on `API key not valid` so it is never picked again, and rotate instantly.
- [ ] **Step 5: Run tests and verify**

---

### Task 2: Modality-Aware Model Pool & Dashboard Quotas Setup (MOD-OPT, ZERO-ERR-02)

**Files:**
- Modify: `src/store.js:24-37, 69, 81`
- Modify: `src/llm.js:35-50`
- Test: `test/test-store.mjs`, `test/test-llm.mjs`

- [ ] **Step 1: Update model hierarchy in `src/store.js`**
  - Configure `DEFAULT_MODEL_POOL` and `TEXT_BACKUP_POOL`:
    - Multimodal Pool: `["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"]`.
    - Text-Only Extended Pool: `["Antigravity", "gemma-4-26b", "gemma-4-31b"]` (Total 14,400+ RPD fallback).
  - Voice Model: `gemini-3.8-live` (Unlimited quota).
- [ ] **Step 2: Add Modality-Aware Model Filter in `src/llm.js`**
  - If payload contains `image`, `video`, or `audio`, restrict pool to Multimodal Gemini models.
  - If payload is text-only, include all models including Gemma-4 for infinite fallback capacity.
- [ ] **Step 3: Run tests and verify**

---

### Task 3: Continuous Typing Heartbeat & Elimination of Premature Timeouts (BUG-08, ZERO-ERR-03)

**Files:**
- Modify: `src/answer.js:80-90, 130-170, 195-245`
- Test: `test/test-flow.mjs`

- [ ] **Step 1: Replace rigid 24s `withBudget` with Active Heartbeat Pipeline**
  - In `src/answer.js`, create a dynamic typing heartbeat interval (sends `sendChatAction(token, chatId, "typing")` every 4 seconds).
  - Increase retry budget to allow thorough key cycling (e.g. up to 60-90 seconds if needed under heavy traffic) so user always gets the answer rather than an error text.
- [ ] **Step 2: Remove user-facing error messages on retryable conditions**
  - Do not send `الان یه کم درگیرم...` or `سقف درخواست پر شد...` to Telegram if there are other keys/models to try.
  - Only in the absolute impossible scenario where every key and provider fails completely should a graceful Persian apology be issued.
- [ ] **Step 3: Run tests and verify**

---

### Task 4: Fix Voice Synthesis WebSocket for Unlimited Live API (BUG-03)

**Files:**
- Modify: `src/voice.js:110-210`
- Test: `test/test-voice.mjs`

- [ ] **Step 1: Implement native Node.js WebSocket in `src/voice.js`**
  - Connect to `wss://` with `globalThis.WebSocket`.
  - Listen for `open` event before sending `setup` payload for `gemini-3.8-live`.
- [ ] **Step 2: Run voice tests and verify**

---

### Task 5: Security, Storage & Telegram Edge Case Fixes (SEC-01..10, BUG-11, BUG-09, BUG-14, BUG-15, BUG-16)

**Files:**
- Modify: `src/index.js:18-56`
- Modify: `src/tools.js:10-96`
- Modify: `src/admin.js:50-65, 608-655`
- Modify: `src/nodeStore.js:20-60`
- Modify: `src/trigger.js:12-25`
- Modify: `src/telegram.js:40-100`
- Modify: `src/text.js:40-55`
- Modify: `bot.js:48-95, 135, 233-245`
- Test: `node test/run-all.mjs`

- [ ] **Step 1: Enforce mandatory constant-time webhook secret verification** (`src/index.js`)
- [ ] **Step 2: Protect `/diag`, `/setup`, `/setup/reset` with `isAuthed`** (`src/tools.js`, `src/index.js`, `bot.js`)
- [ ] **Step 3: Mask raw API keys in `/admin/api/keys`** (`src/keyPool.js`, `src/admin.js`)
- [ ] **Step 4: Atomic non-blocking file writes (`tmp + rename`) in `src/nodeStore.js`**
- [ ] **Step 5: Refine Persian wake-word regex and group command routing in `src/trigger.js`**
- [ ] **Step 6: Forward `message_thread_id` and fix emoji surrogate pair splitting in `src/text.js`**
- [ ] **Step 7: Full regression test run: all 15 test suites green**
