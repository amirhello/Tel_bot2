# Design Document: User-Scoped Personas & Dynamic 1,000-Token Memory System

**Document ID:** `2026-10-31-user-memory-and-personas-design`  
**Date:** 2026-10-31  
**Project:** Sayyad Telegram Bot (`sayyad-bot`)  
**Status:** Draft for Review  

---

## 1. Executive Summary & Intent

### 1.1 The "Why"
Currently, the Sayyad Telegram Bot applies a single global persona configured by the administrator in the `/admin` dashboard across all users, with no persistent memory of individual user interactions. While effective for basic Q&A, users expect a deeply engaging, personalized experience where:
1. Each user can choose how the bot relates to them (e.g. as an empathetic psychologist, a loyal best friend, or a sharp market strategist).
2. The bot builds an evolving, authentic understanding of who the user is over time—their personality, background, struggles, and habits—without requiring the user to repeat themselves.
3. Users retain full transparency and control over their stored memory, with a one-click button to inspect or wipe it clean.

---

## 2. Goals, Non-Goals, and Anti-Goals

### 2.1 Goals
1. **6 Distinct, Rich Personas:**
   - 🧠 **Psychologist (`psychologist`):** Deep listener, emotional validator, reflective counselor.
   - 🤝 **Best Friend (`friend`):** Loyal, brotherly, high-energy colloquial Tehrani companion.
   - 👑 **Know-It-All (`smart`):** Charismatic genius, sharp analytical insights, no formulaic clichés.
   - ⚡ **Sarcastic / Savage (`rude`):** Surgical wit, sharp comebacks, comedic irony and satire.
   - 🐺 **Market Strategist (`wolf`):** Pragmatic, money/opportunity-focused, zero fluff.
   - 📖 **Polite Scholar (`polite`):** Dignified, warm, courteous classical etiquette.
2. **Per-User Persona Selection (`/mode`):**
   - Each user can trigger `/mode` or `/شخصیت` to view Telegram inline buttons and pick their preferred persona.
   - Selection is saved per numeric user ID in KV (`user:<id>:mode`).
3. **Dynamic 1,000-Token User Memory:**
   - Evolving psychological and biographical profile (up to ~1,000 tokens) saved per numeric user ID in KV (`user:<id>:memory`).
   - Universal across all personas for that user (a single, unified memory).
   - Injected seamlessly into every prompt so the AI acts with full awareness of the user.
4. **Memory Transparency & Reset (`/memory`):**
   - Users can trigger `/memory` or `/حافظه` to view what the AI currently knows about them.
   - Includes an inline button: `[🗑️ فراموشی و پاک‌سازی حافظه]`. Tapping it wipes their memory instantly.
5. **Zero Latency Impact on Telegram Replies:**
   - Memory profile updates occur asynchronously in `ctx.waitUntil()` after the reply is already delivered to the user.

### 2.2 Non-Goals
- Vector database / RAG search infrastructure (a structured, consolidated markdown profile is far lighter, faster, and cheaper).
- Storing raw multi-thousand message chat histories.
- Allowing users to override global security, rate-limiting, or admin authentication.

### 2.3 Anti-Goals
- Never leak one user's memory or selected persona to another user or group.
- Never let memory exceed the 1,000-token ceiling (~400-500 words).
- Never break existing features: Web Search (`src/search.js`), Gemini Live voice replies (`src/voice.js`), KeyPool, or `/admin` panel.

---

## 3. Architecture & Data Schema

### 3.1 Storage in Cloudflare KV (`CONFIG` namespace)

| Key Pattern | Format | Description |
| :--- | :--- | :--- |
| `user:<userId>:mode` | String (e.g. `"psychologist"`) | The active persona for user `userId`. Defaults to `cfg.mode` if unset. |
| `user:<userId>:memory` | String (Markdown text) | The evolving memory dossier (max 1,000 tokens). Defaults to empty string. |

### 3.2 Telegram Interaction Flow

```
[User sends /mode in Telegram]
       │
       ▼
[Bot displays inline buttons with 6 personas]
       │
       ▼
[User taps "🧠 روانشناس"]
       │
       ▼
[Callback query: mode:psychologist]
       │
       ▼
[Save user:<userId>:mode = "psychologist"]
       │
       ▼
[Bot edits message: "شخصیت من برات شد «روانشناس». هر چه در دل داری بگو، می‌شنوم..."]
```

```
[User sends regular message (e.g. "امروز حالم گرفته بود...")]
       │
       ▼
[Load user:<userId>:mode (e.g. "psychologist")]
[Load user:<userId>:memory (e.g. "امیرحسین، برنامه‌نویس، حساس به کیفیت کار...")]
       │
       ▼
[Assemble prompt with persona + memory context + web search if needed]
       │
       ▼
[Generate response & send text / voice to Telegram immediately]
       │
       ▼ (in ctx.waitUntil)
[Asynchronous Memory Consolidation Turn: update user:<userId>:memory if new facts/emotions emerged]
```

```
[User sends /memory in Telegram]
       │
       ▼
[Bot displays current memory profile]
       │
[Attached inline button: [🗑️ فراموشی و پاک‌سازی حافظه]]
       │
       ▼
[User taps button -> Callback query: memory:forget]
       │
       ▼
[Delete user:<userId>:memory in KV]
       │
       ▼
[Bot edits message: "تمام حافظه و شناخت من از شما پاک شد. یک صفحه سفید جدید!"]
```

---

## 4. Personas Specification

The 6 personas are stored in `src/prompt.js` under `DEFAULT_PERSONAS`:

1. **`psychologist` (روانشناس):**
   - *Voice & Demeanor:* صبور، عمیق، همدل، بدون قضاوت.
   - *Core Behavior:* بازتاب احساسات کاربر، پرسیدن سوالات عمیق و باز برای درک ریشه حال و هوا، پیشنهاد زاویه‌دیدهای روان‌شناختی، ایجاد فضای امن و آرامش‌بخش.

2. **`friend` (رفیق فاب):**
   - *Voice & Demeanor:* صمیمی، مشتی، با مرام، ادبیات محاوره‌ای تهرانی امروزی.
   - *Core Behavior:* همراهی بی‌قید و شرط، پرانرژی، پایه‌ترین رفیق، دلسوز و همیشه در دسترس.

3. **`smart` (دانای کل):**
   - *Voice & Demeanor:* باهوش، کاریزماتیک، زیرک، با اعتماد به نفس بالا.
   - *Core Behavior:* پاسخ‌های پرمغز، دیدن زوایایی که دیگران نمی‌بینند، پرهیز از کلی‌گویی و فرمول‌های تکراری.

4. **`rude` (بی‌رحم / سارکاستیک):**
   - *Voice & Demeanor:* حاضرجواب، رند، تیکه‌انداز تیز، شوخ‌طبعی گزنده.
   - *Core Behavior:* شوخی‌های سارکاستیک، تیکه‌های هوشمندانه روی صحبت کاربر بدون فحاشی مستقیم یا بی‌احترامی به خانواده، پاسخ دقیق در عین حال‌گیری.

5. **`wolf` (استراتژیست / گرگ بازار):**
   - *Voice & Demeanor:* رک، واقع‌بین، متمرکز روی فرصت‌ها، پول و دستاورد.
   - *Core Behavior:* حذف توهم و رویاپردازی، چیدن استراتژی‌های عملی برای برد، مدیریت زمان و بهره‌وری بالا.

6. **`polite` (ادیب):**
   - *Voice & Demeanor:* شمرده، باوقار، متین، ادب کهن و اصیل.
   - *Core Behavior:* احترام فراوان، لحن پاکیزه، صبوری کامل در پاسخ به هر نوع سوال.

---

## 5. Memory Engine Specification

### 5.1 Memory Schema Format (Markdown)
The 1,000-token memory block maintains this clear internal structure:
```markdown
# پرونده شناخت کاربر
- هویت و زمینه: [نام/لقب، شغل، شهر، شرایط زندگی]
- الگوهای شخصیتی و روحی: [ویژگی‌های بارز، نحوه تفکر، دغدغه‌های تکرارشونده]
- اهداف و موضوعات مهم جاری: [پروژه‌ها، تصمیم‌ها، چالش‌ها]
- تمایلات مکالمه: [لحن مورد علاقه، خط قرمزها، موضوعات جذاب]
- خلاصه تعاملات اخیر: [نکات کلیدی گفتگوهای گذشته]
```

### 5.2 Background Consolidation Algorithm
1. After delivering a turn, if the conversation turn contained personal revelations or significant context, a background job is scheduled via `ctx.waitUntil`.
2. A fast, low-token prompt (using `gemini-3.1-flash-lite` or `gemini-3.5-flash-lite`) updates the profile:
   - Integrates new facts.
   - Condenses and merges older observations.
   - Ensures total token count stays under 1,000 tokens.
3. The resulting markdown is saved to `user:<userId>:memory`.
4. If no new personal facts or insights occurred (e.g. simple dollar price query or hello), the consolidation turn is skipped to conserve quota.

---

## 6. Implementation Scope & Milestones

1. **Phase 1: Personas Expansion (`src/prompt.js` & `src/store.js`)**
   - Define all 6 personas in `DEFAULT_PERSONAS` and update labels.
   - Keep global admin override in `/admin` as fallback.
2. **Phase 2: Telegram Commands & Callback Router (`src/telegram.js`, `src/trigger.js`, `src/index.js`)**
   - Support `/mode` and `/شخصیت` command.
   - Build inline keyboard UI for persona selection.
   - Handle callback queries (`mode:*` and `memory:forget`).
3. **Phase 3: Memory Storage & Injection (`src/answer.js` & `src/memory.js`)**
   - Create `src/memory.js` with `loadUserMemory`, `saveUserMemory`, `clearUserMemory`, `consolidateMemory`.
   - Inject memory context cleanly into `buildUserContent()`.
4. **Phase 4: Unit & Flow Testing (`test/test-memory.mjs`, `test/test-mode.mjs`)**
   - Comprehensive offline mock tests for persona switching, memory retention, pruning, and callback queries.
   - Full verification via `node test/run-all.mjs`.

---

## 7. Review & Verification Gate
This design will be audited by a builder reviewer before any code is modified, followed by human partner approval.
