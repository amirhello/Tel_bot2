# Spec: 6 Personas, User-Scoped Mode Selection & Admin User Management

**Document ID:** `2026-11-01-personas-and-user-management-spec`  
**Date:** 2026-11-01  
**Project:** Sayyad Telegram Bot (`sayyad-bot`)  
**Deployment Target:** WispByte Node.js Container (500MB RAM / 1GB Disk / 35% CPU)  
**Status:** Approved for Implementation  

---

## 1. Executive Summary & Intent

This specification defines two tightly coupled features for the Sayyad Telegram Bot:
1. **6 High-Fidelity Persian Personas & Per-User Mode Selection (`/mode` and `/شخصیت`):**
   Allows each individual user to choose which persona Sayyad adopts when talking to them, preserved across messages based on their unique numeric Telegram User ID.
2. **Comprehensive Admin User Management (`/admin`):**
   A dedicated "Users" tab in the `/admin` dashboard that lists all registered users, tracks their interaction metrics (message counts, first/last seen timestamps), displays their active persona, allows administrators to override or reset their persona mode, and provides one-click blocking/unblocking (banning) capabilities.

---

## 2. Infrastructure & Hosting Context

- **Host:** WispByte (`https://wispbyte.com/`)
- **Runtime:** Native Node.js 18+ (JS environment running `node bot.js`).
- **Resource Constraints:** 500 MB RAM, 1 GB Disk, 35% CPU.
- **Telegram Connection:** 24/7 Long-Polling loop (`bot.js`) + embedded HTTP server on port 10638 for the Admin dashboard and diagnostics.
- **Persistence Engine:** Zero external database needed; persisted locally via `FileKV` in `data/store.json`.

---

## 3. Requirements & Boundaries

### 3.1 The 6 Personas
The bot supports 6 distinct personas defined in `src/prompt.js`:
- `psychologist` (روانشناس): Empathic, deep emotional listener, non-judgmental guidance, reflective inquiry.
- `friend` (رفیق فاب): Loyal, brotherly, warm colloquial Tehrani slang, high-energy companion.
- `smart` (دانای کل): Charismatic genius, sharp analytical insights, no formulaic clichés.
- `rude` (بی‌رحم / سارکاستیک): Sharp-witted, dark humor, surgical sarcasm, witty comebacks (no gratuitous vulgarity).
- `wolf` (استراتژیست / گرگ بازار): Pragmatic, opportunity/money/results-focused, ruthless efficiency.
- `polite` (ادیب): Dignified, courteous, graceful classical Persian eloquence.

### 3.2 User-Scoped Mode Selection
- **Telegram Commands:** `/mode` and `/شخصیت` (case-insensitive, optional bot username suffix like `/mode@SayyadBot`).
- **Inline Keyboard:** Shows 6 inline buttons arranged in a clean 2x3 grid:
  - `[🧠 روانشناس]` (`mode:psychologist`)
  - `[🤝 رفیق فاب]` (`mode:friend`)
  - `[👑 دانای کل]` (`mode:smart`)
  - `[⚡ بی‌رحم]` (`mode:rude`)
  - `[🐺 گرگ بازار]` (`mode:wolf`)
  - `[📖 ادیب]` (`mode:polite`)
- **Callback Query Handling:**
  - Tapping a button triggers a Telegram `callback_query` with `data: "mode:<persona>"`.
  - The long-polling loop in `bot.js` (and webhook handler in `src/index.js`) handles `update.callback_query`.
  - Saves `user:<userId>:mode` in `FileKV`.
  - Updates user metadata in `user:<userId>:meta`.
  - Responds via `answerCallbackQuery(token, query.id, text)`.
  - Edits the prompt message via `editMessageText` with a welcoming persona confirmation.
- **Precedence:** When a user chats with Sayyad, the bot checks `user:<userId>:mode`. If set and valid, it overrides `cfg.mode`. Otherwise, it falls back to global `cfg.mode`.

### 3.3 User Management in `/admin`
- **User Activity Recording (`src/users.js`):**
  - On every incoming message from a non-bot user:
    - Automatically upsert `user:<userId>:meta`:
      ```json
      {
        "id": 12345678,
        "name": "Ali Rezaei",
        "username": "alirez",
        "firstSeen": 1730419200000,
        "lastSeen": 1730419500000,
        "messageCount": 15,
        "blocked": false,
        "mode": "friend"
      }
      ```
    - Maintain `users:index` (an array of user IDs, capped at 1000 users).
- **Access Control / Blocking:**
  - If a user has `blocked: true` (or `user:<userId>:blocked` in storage):
    - The bot refuses to answer their messages.
    - An ignored record is archived with reason `"user blocked by admin"`.
- **Dashboard Interface (`src/admin.js`):**
  - New tab: **Users** (`کاربران`).
  - Table / Card list displaying:
    - User ID & Display Name / @username.
    - First & Last Seen formatted in local Iranian / readable time.
    - Total message count.
    - Active persona dropdown selector.
    - Status badge (`Active` or `Blocked`).
    - Action buttons:
      - `[Block / Unblock]`: instantly toggles ban status.
      - `[Reset]`: resets persona to default and clears custom flags.
- **REST Endpoints (`/admin/api/users*`):**
  - `GET /admin/api/users`: Returns `{ count: number, users: Array<UserMeta> }`.
  - `POST /admin/api/users/block`: Body `{ userId: number, blocked: boolean }`.
  - `POST /admin/api/users/mode`: Body `{ userId: number, mode: string }`.
  - `POST /admin/api/users/reset`: Body `{ userId: number }`.

---

## 4. Data Schema & Storage Keys (`FileKV`)

| Key | Type | Description |
| :--- | :--- | :--- |
| `users:index` | Array<number> | Ordered list of unique Telegram user IDs. Capped at 1000. |
| `user:<userId>:meta` | JSON Object | User metadata: id, name, username, firstSeen, lastSeen, messageCount, blocked, mode. |
| `user:<userId>:mode` | String | Active persona string. Quick lookup cache. |
| `user:<userId>:blocked` | Boolean (or "1") | Quick lookup cache for block status. |

---

## 5. Verification & Constraints
- Pure Node.js 18+ runtime; zero third-party packages.
- Memory and CPU friendly: respects WispByte container limits (500 MB RAM / 35% CPU).
- No impact on existing 18 test suites.
- Complete offline unit test coverage for `src/users.js`, `/mode` inline keyboards, callback query routing, and `/admin/api/users*` endpoints.
