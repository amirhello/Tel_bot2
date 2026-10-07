// ============================================================================
//  Sayyad — Telegram bot on Cloudflare Workers
//  GENERATED FILE. Do not edit by hand: edit ./src and run "node build.mjs".
//  Module order, resolved from the import graph: archive.js, http.js, store.js, providerGemini.js, providerOpenai.js, llm.js, text.js, trigger.js, prompt.js, admin.js, telegram.js, media.js, voice.js, answer.js, tools.js, index.js
// ============================================================================

// ------------------------------ src/archive.js ------------------------------
// The admin's own copy of everything Telegram delivered. Never sent to the model.

const ARCHIVE_KEY = "log:v1";
const ARCHIVE_LIMIT = 200;

/** Build one record. Media is described, never stored. */
function archiveRecord(msg, outcome) {
  const isObj = typeof outcome === "object" && outcome !== null;
  const answered = isObj ? outcome.answered : !!outcome;
  const r = {
    t: msg.date ? msg.date * 1000 : Date.now(),
    u: {
      id: msg.from?.id,
      name: msg.from?.first_name || msg.from?.last_name || msg.from?.username || String(msg.from?.id ?? ""),
    },
    c: { id: msg.chat?.id, t: msg.chat?.title || msg.chat?.type },
    m: msg.message_id,
    x: msg.text || msg.caption || "",
    k: mediaKind(msg),
    a: answered,
  };
  if (isObj) {
    if (outcome.ok !== undefined) r.ok = outcome.ok;
    if (outcome.model) r.model = outcome.model;
    if (outcome.reply) r.reply = String(outcome.reply).slice(0, 4000);
    if (outcome.error) r.err = String(outcome.error).slice(0, 1000);
  }
  return r;
}

/** A short label for the media on a message, without touching any bytes. */
function mediaKind(msg) {
  const kinds = [];
  if (msg.photo?.length) kinds.push("photo");
  if (msg.video) kinds.push("video");
  if (msg.video_note) kinds.push("video note");
  if (msg.animation) kinds.push("animation");
  if (msg.document) kinds.push("document");
  if (msg.voice) kinds.push("voice");
  if (msg.audio) kinds.push("audio");
  if (msg.sticker) kinds.push("sticker");
  return kinds.length ? kinds.join(", ") : "text only";
}

async function readArchive(env) {
  try {
    const raw = await env.CONFIG.get(ARCHIVE_KEY, "json");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Prepend a record and drop the oldest past the limit. Never throws. */
async function appendArchive(env, record) {
  try {
    const items = await readArchive(env);
    items.unshift(record);
    await env.CONFIG.put(ARCHIVE_KEY, JSON.stringify(items.slice(0, ARCHIVE_LIMIT)));
  } catch {
    /* the free KV tier runs out of writes; the archive is optional, the bot is not */
  }
}

// ------------------------------ src/http.js ------------------------------
// Shared HTTP plumbing for every provider. Keeping it separate means the provider modules
// depend on this, not on each other, and the dispatcher never has to import them back.

/** An HTTP failure that carries its status, so callers can tell 400 from 429. */
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Failures worth another go. 0 means the request never got an answer (DNS, TLS, a
 * dropped socket) — retrying that is free. 429 and 5xx are the provider saying "not right
 * now", which is exactly what a short pause fixes.
 *
 * Deliberately NOT here: 400, 401, 403, 404, 422. Those never resolve themselves, and
 * retrying only burns latency and quota.
 */
const TRANSIENT = new Set([0, 408, 429, 500, 502, 503, 504]);

/** Default retry policy: anything that looks temporary. */
const isTransient = (e) => TRANSIENT.has(e.status);

/** Waits between attempts. Sleeping costs no CPU on Workers, only wall-clock time. */
const DEFAULT_BACKOFF = [700, 2000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (json, text) =>
  json?.error?.message ?? json?.error?.error?.message ?? json?.error?.status ?? String(text ?? "").slice(0, 200);

/**
 * POST JSON, parse the reply, and retry a transient failure a couple of times.
 *
 * `retries` is extra attempts, so the default sends at most 3 requests. `retryOn` lets a
 * caller refine the policy — Gemini passes one that keeps a spent daily quota from being
 * retried three times per model, which would burn the whole pool to learn what we already
 * read in the first message. A non-JSON body still throws with its real status, so a
 * Cloudflare HTML block page reads as 403 and is not retried into oblivion.
 */
async function callJson(url, { headers, body, retries = 2, backoff = DEFAULT_BACKOFF, retryOn = isTransient }) {
  const attempts = Math.max(0, retries) + 1;
  let last;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]);

    let error;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();

      let json;
      let parsed = false;
      try {
        json = JSON.parse(text);
        parsed = true;
      } catch {
        /* an HTML error page, a proxy timeout, a truncated body */
      }

      if (parsed && res.ok && !json?.error) return json;

      error = parsed
        ? new ApiError(`API ${res.status}: ${errorMessage(json, text)}`, res.status)
        : new ApiError(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      error = new ApiError(`network error: ${String(e?.message ?? e)}`, 0);
    }

    if (!retryOn(error)) throw error;
    last = error;
  }

  throw last;
}

/** A rejected request shape is worth retrying differently; 429 or 5xx must surface as-is. */
const isShapeError = (e) => e instanceof ApiError && (e.status === 400 || e.status === 422);

/** A missing credential is the only reason to try the other provider. */
const isCredentialError = (e) => e instanceof ApiError && (e.status === 500 && /API key|secret/i.test(e.message));

// ------------------------------ src/store.js ------------------------------
// Everything that touches the KV namespace: config, stats and migration.

const SCHEMA_VERSION = 3;

const CONFIG_KEY = "config:v2";
const STATS_KEY = "stats:v2";
const QUOTA_KEY = "quota:v1";
const LEGACY_CONFIG_KEY = "config:v1";
const LEGACY_STATS_KEY = "stats:v1";

/** Google's daily quota resets at midnight Pacific. We park a model until then. */
const PACIFIC_OFFSET_MS = -8 * 3600 * 1000;

function nextPacificMidnight(now = Date.now()) {
  const shifted = now + PACIFIC_OFFSET_MS;
  const startOfDay = Math.floor(shifted / 86400000) * 86400000;
  return startOfDay + 86400000 - PACIFIC_OFFSET_MS;
}

/**
 * Tried strongest-first. Names are provider-specific: if one is wrong the provider
 * answers 404 and the model is parked for a day instead of being retried forever.
 */
const DEFAULT_MODEL_POOL = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "Antigravity",
  "gemma-4-26b",
  "gemma-4-31b",
];

/* ------------------------------------------------------------------ config */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const SAFETY_LEVELS = ["BLOCK_NONE", "BLOCK_ONLY_HIGH", "BLOCK_MEDIUM_AND_ABOVE", "BLOCK_LOW_AND_ABOVE", "OFF"];

const SAFETY_CATEGORIES = {
  harassment: "HARM_CATEGORY_HARASSMENT",
  hateSpeech: "HARM_CATEGORY_HATE_SPEECH",
  sexuallyExplicit: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  dangerous: "HARM_CATEGORY_DANGEROUS_CONTENT",
};

const SAFETY_CATEGORY_KEYS = Object.keys(SAFETY_CATEGORIES);

const DEFAULT_BASE_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://openrouter.ai/api/v1",
};

function defaultConfig(personas) {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    mode: "smart",
    maxTokens: 2000,
    thinking: "medium",
    extra: "",
    dailyCap: 1000, // across the whole model pool, not per model
    provider: {
      kind: "gemini",
      model: "gemini-3.8-flash",
      baseUrl: DEFAULT_BASE_URLS.gemini,
      modelPool: [...DEFAULT_MODEL_POOL],
    },
    safety: { harassment: "BLOCK_NONE", hateSpeech: "BLOCK_NONE", sexuallyExplicit: "BLOCK_NONE", dangerous: "BLOCK_NONE" },
    media: {
      image: { enabled: true, maxMB: 4, maxPer: 2 },
      video: { enabled: true, maxMB: 4, maxPer: 1 },
      audio: { enabled: true, maxMB: 8, maxPer: 1 },
    },
    voice: {
      enabled: true,
      model: "gemini-3.8-live",
    },
    personas: { ...personas },
  };
}

/** Repair any value that is missing, out of range or of the wrong shape. */
function normalizeConfig(saved, personas) {
  const base = defaultConfig(personas);
  const c = { ...base, ...(saved ?? {}) };

  c.provider = { ...base.provider, ...(saved?.provider ?? {}) };
  if (!["gemini", "openai"].includes(c.provider.kind)) c.provider.kind = "gemini";
  // The base URL belongs to a provider, so an unset one follows the provider kind.
  c.provider.baseUrl = String(saved?.provider?.baseUrl || DEFAULT_BASE_URLS[c.provider.kind]).replace(/\/+$/, "");
  c.provider.model = String(c.provider.model || base.provider.model);
  c.provider.modelPool = normalizePool(c.provider.modelPool, c.provider.model);

  c.safety = { ...base.safety };
  for (const k of Object.keys(SAFETY_CATEGORIES)) {
    if (SAFETY_LEVELS.includes(saved?.safety?.[k])) c.safety[k] = saved.safety[k];
  }

  c.media = { ...base.media };
  for (const k of Object.keys(base.media)) {
    const m = saved?.media?.[k] ?? {};
    c.media[k] = {
      enabled: m.enabled !== false,
      maxMB: clampNum(m.maxMB, 1, 19, base.media[k].maxMB),
      maxPer: clampNum(m.maxPer, 1, 4, base.media[k].maxPer),
    };
  }

  c.voice = {
    enabled: saved?.voice?.enabled !== false,
    model: String(saved?.voice?.model || base.voice.model).trim(),
  };

  c.thinking = THINKING_LEVELS.includes(c.thinking) ? c.thinking : "medium";
  c.maxTokens = clampNum(c.maxTokens, 200, 8000, 2000);
  c.dailyCap = clampNum(c.dailyCap, 0, 100000, 1000);
  c.extra = String(c.extra ?? "").slice(0, 4000);
  c.enabled = c.enabled !== false;
  c.mode = ["polite", "smart", "rude"].includes(c.mode) ? c.mode : "smart";

  const merged = { ...personas, ...(saved?.personas ?? {}) };
  c.personas = {};
  for (const m of ["polite", "smart", "rude"]) c.personas[m] = String(merged[m] ?? personas[m]).slice(0, 6000);
  c.schemaVersion = SCHEMA_VERSION;

  return c;
}

/** One model per line, de-duplicated, the configured model always tried first. */
function normalizePool(value, primary) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split("\n"))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 24);
  if (primary) list.unshift(String(primary).trim());
  return [...new Set(list)];
}

/**
 * Numbers above the ceiling are clamped (an admin typing a huge max is fine); numbers
 * below the floor fall back to the default, because "below 0" on a budget or a limit is
 * always a mistake and silently clamping to 0 would disable the guard it configures.
 */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.round(n));
}

/** Pull a v1 record forward so an existing install keeps its personas and mode. */
function migrateLegacy(legacy, legacyStats, personas) {
  const fresh = defaultConfig(personas);
  if (!legacy || typeof legacy !== "object") return { config: fresh, stats: legacyStats ?? null };

  const config = {
    ...fresh,
    enabled: legacy.enabled !== false,
    mode: ["polite", "smart", "rude"].includes(legacy.mode) ? legacy.mode : "smart",
    maxTokens: legacy.maxTokens ?? fresh.maxTokens,
    dailyCap: legacy.dailyCap ?? fresh.dailyCap,
    extra: legacy.extra ?? "",
    personas: { ...personas, ...(legacy.personas ?? {}) },
    media: {
      ...fresh.media,
      video: { ...fresh.media.video, maxMB: legacy.videoCapMB ?? fresh.media.video.maxMB },
    },
  };
  return { config, stats: legacyStats ?? null };
}

/* ------------------------------------------------------------------ kv io */

async function readKey(env, key, fallback = null) {
  try {
    const v = await env.CONFIG.get(key, "json");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeKey(env, key, value) {
  await env.CONFIG.put(key, JSON.stringify(value));
}

async function loadConfig(env, personas) {
  let saved = await readKey(env, CONFIG_KEY);
  let stats = await readKey(env, STATS_KEY);

  if (!saved) {
    const legacy = await readKey(env, LEGACY_CONFIG_KEY);
    const legacyStats = await readKey(env, LEGACY_STATS_KEY);
    if (legacy || legacyStats) {
      const moved = migrateLegacy(legacy, legacyStats, personas);
      saved = moved.config;
      stats = moved.stats ?? stats;
      await writeKey(env, CONFIG_KEY, saved);
      await writeKey(env, STATS_KEY, stats);
    }
  }

  // The daily cap moved from 50 to 1000 when the model pool arrived. An untouched 50 on an
  // older schema is the old default, not a decision the admin made, so it should follow.
  if (saved && (saved.schemaVersion ?? 0) < SCHEMA_VERSION && saved.dailyCap === 50) {
    saved = { ...saved, dailyCap: 1000 };
    await writeKey(env, CONFIG_KEY, normalizeConfig(saved, personas));
  }

  return { config: normalizeConfig(saved, personas), stats: normalizeStats(stats) };
}

async function saveConfig(env, config) {
  const clean = normalizeConfig(config, config.personas);
  await writeKey(env, CONFIG_KEY, clean);
  return clean;
}

/* ------------------------------------------------------------------ stats */

const EMPTY_STATS = { requests: 0, errors: 0, replies: 0, day: null, today: 0, lastUsed: null, lastError: null, recentErrors: [] };

function normalizeStats(s) {
  return {
    ...EMPTY_STATS,
    ...(s ?? {}),
    requests: Number(s?.requests ?? 0),
    errors: Number(s?.errors ?? 0),
    replies: Number(s?.replies ?? 0),
    today: Number(s?.today ?? 0),
    recentErrors: Array.isArray(s?.recentErrors) ? s.recentErrors.slice(0, 20) : [],
  };
}

const todayKey = () => new Date().toISOString().slice(0, 10);

function usedToday(stats, day = todayKey()) {
  return stats?.day === day ? stats?.today ?? 0 : 0;
}

async function loadStats(env) {
  return normalizeStats(await readKey(env, STATS_KEY));
}

/* ------------------------------------------------------------------ per-model quota parking */

/**
 * { "<model>": <epoch ms when it becomes available again> }. A model is "parked" while its
 * daily quota is spent; the entry expires on its own, so no cleanup job is needed.
 */
async function loadQuota(env) {
  const raw = await readKey(env, QUOTA_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

async function saveQuota(env, quota) {
  try {
    await writeKey(env, QUOTA_KEY, quota);
  } catch {
    /* if we cannot remember, we simply re-try the model tomorrow */
  }
}

/** When the last parked model in the pool frees up, the bot can answer again. */
function poolResumeTime(quota, pool) {
  const now = Date.now();
  const active = pool.filter((m) => (quota[m] ?? 0) > now);
  if (active.length < pool.length) return now;
  const times = pool.map((m) => quota[m] ?? 0).filter(Boolean);
  return times.length ? Math.max(...times) : now;
}

async function bumpStats(env, patch) {
  const s = await loadStats(env);
  const errList = Array.isArray(s.recentErrors) ? [...s.recentErrors] : [];
  if (patch.lastError) {
    errList.unshift({ t: Date.now(), msg: String(patch.lastError).slice(0, 300) });
    if (errList.length > 20) errList.length = 20;
  }
  const next = {
    day: todayKey(),
    today: usedToday(s) + (patch.requests ?? 0),
    requests: s.requests + (patch.requests ?? 0),
    errors: patch.resetErrors ? 0 : s.errors + (patch.errors ?? 0),
    replies: s.replies + (patch.replies ?? 0),
    lastUsed: patch.lastUsed ?? s.lastUsed,
    lastError: patch.lastError !== undefined ? patch.lastError : s.lastError,
    recentErrors: patch.clearErrors ? [] : errList,
  };
  try {
    await writeKey(env, STATS_KEY, next);
  } catch {
    /* counters are never worth failing a reply over */
  }
  return next;
}

// ------------------------------ src/providerGemini.js ------------------------------
// Gemini's native API — the only path that accepts video and audio.
//
// Wire format: { inlineData: { mimeType, data } } under
// POST {baseUrl}/models/{model}:generateContent




/** This model's daily quota is spent. Distinct from a per-minute 429: waiting does not help. */
class DailyQuotaError extends ApiError {
  constructor(model, message) {
    super(message, 429);
    this.name = "DailyQuotaError";
    this.model = model;
    this.resetAt = nextPacificMidnight();
  }
}

/** This model's per-minute quota is spent (RPM/TPM). Parked for 60 seconds. */
class MinuteQuotaError extends ApiError {
  constructor(model, message, resetAt = Date.now() + 60_000) {
    super(message, 429);
    this.name = "MinuteQuotaError";
    this.model = model;
    this.resetAt = resetAt;
  }
}

/** The provider does not know this model name. Never worth trying again today. */
class UnknownModelError extends ApiError {
  constructor(model, message) {
    super(message, 404);
    this.name = "UnknownModelError";
    this.model = model;
  }
}

/**
 * "Requests per day" and "requests per minute" both surface as 429 but call for opposite
 * reactions, so read the wording before deciding.
 */
function quotaKind(message) {
  const m = String(message ?? "").toLowerCase();
  if (/(?:^|[^a-z])(day|daily|rpd|24\s*h)(?:[^a-z]|$)/i.test(m)) return "day";
  if (/(?:^|[^a-z])(minute|min|rpm|tpm)(?:[^a-z]|$)/i.test(m)) return "minute";
  return "other";
}

/** Neutral part -> Gemini part. Everything binary becomes inlineData. */
function toGeminiPart(part) {
  if (part.type === "text") return { text: part.text };
  if (part.type === "image" || part.type === "video" || part.type === "audio") {
    return { inlineData: { mimeType: part.mime, data: part.data } };
  }
  return null;
}

/**
 * thinkingConfig. Gemini 3 cannot be switched off, so "off" simply omits the block and
 * lets the model use its own default.
 */
function thinkingConfig(cfg) {
  if (!cfg.thinking || cfg.thinking === "off") return {};
  return { thinkingConfig: { thinkingLevel: cfg.thinking, includeThoughts: false } };
}

function safetySettings(cfg) {
  return Object.entries(SAFETY_CATEGORIES).map(([key, category]) => ({
    category,
    threshold: cfg.safety?.[key] ?? "BLOCK_NONE",
  }));
}

function buildGeminiBody(cfg, { system, parts, maxTokens }, shape = {}) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: parts.map(toGeminiPart).filter(Boolean) }],
    generationConfig: { maxOutputTokens: maxTokens, ...thinkingConfig(cfg) },
  };
  if (!shape.noThinking) body.generationConfig = { ...body.generationConfig, ...thinkingConfig(cfg) };
  else delete body.generationConfig.thinkingConfig;
  if (!shape.noSafety) body.safetySettings = safetySettings(cfg);
  return body;
}

/** Gemini returns parts, not a single string; join every text part it produced. */
function readGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
}

/**
 * A spent quota (day or minute) is not retried with backoff on the same model —
 * we want to move on to the next model in the pool immediately.
 */
const retryableForGemini = (e) =>
  isTransient(e) &&
  quotaKind(e.message) !== "day" &&
  quotaKind(e.message) !== "minute" &&
  !/quota|resource_exhausted/i.test(e.message);

/**
 * Models differ in which knobs they accept — Gemma rejects thinkingConfig, some tiers
 * refuse a custom safety level. Drop the optional blocks one at a time rather than
 * letting the admin discover it as a broken bot.
 */
function shapes(cfg) {
  const list = [{}];
  if (cfg.thinking && cfg.thinking !== "off") list.push({ noThinking: true });
  list.push({ noThinking: true, noSafety: true });
  return list;
}

async function completeGemini(env, cfg, { system, parts, maxTokens }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new ApiError("GEMINI_API_KEY secret is not set", 500);

  const model = cfg.provider.model;
  const url = `${cfg.provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  let last = new ApiError("model returned an empty answer");

  for (const shape of shapes(cfg)) {
    let data;
    try {
      data = await callJson(url, {
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: buildGeminiBody(cfg, { system, parts, maxTokens }, shape),
        retryOn: retryableForGemini,
      });
    } catch (e) {
      if (e.status === 404) throw new UnknownModelError(model, `${model}: ${e.message}`);
      const isQuota =
        (e.status === 429 || e.status === 503) &&
        (quotaKind(e.message) !== "other" || /quota|resource_exhausted/i.test(e.message));
      if (isQuota) {
        if (quotaKind(e.message) === "day") {
          throw new DailyQuotaError(model, `${model}: ${e.message}`);
        }
        throw new MinuteQuotaError(model, `${model}: ${e.message}`);
      }
      // A rejected knob is worth retrying with fewer of them; anything else must surface.
      if (!isShapeError(e) || shape === shapes(cfg).at(-1)) throw e;
      last = e;
      continue;
    }

    const text = readGeminiText(data);
    if (text) return { text, usage: data.usageMetadata ?? null, model };

    const candidate = data?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const blocked = data?.promptFeedback?.blockReason ?? candidate?.safetyRatings?.[0]?.category;
    last = new ApiError(
      `Gemini returned no text${finishReason ? ` (${finishReason})` : ""}${blocked ? ` (blocked: ${blocked})` : ""}`,
      200,
    );
    break; // the request itself worked; another shape would change nothing
  }

  throw last;
}

// ------------------------------ src/providerOpenai.js ------------------------------
// OpenAI-compatible providers: OpenRouter, justwoker, and Gemini's compatibility layer.
//
// Wire format: { type: "image_url" | "video_url" | "input_audio", ... }



/** Neutral part -> OpenAI content part. */
function toOpenAIPart(part) {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") return { type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}` } };
  if (part.type === "video") return { type: "video_url", video_url: { url: `data:${part.mime};base64,${part.data}` } };
  if (part.type === "audio") return { type: "input_audio", input_audio: { data: part.data, format: audioFormat(part.mime) } };
  return null;
}

function audioFormat(mime) {
  const m = String(mime ?? "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "wav";
}

/** Thinking hint, only when the config asks for one. */
function thinkingBody(cfg) {
  return cfg.thinking && cfg.thinking !== "off" ? { reasoning: { effort: cfg.thinking } } : {};
}

/** Retry shapes that some providers reject: the hint, then the newer field name. */
function attempts(maxTokens, cfg) {
  const list = [{ max_tokens: maxTokens }, { max_completion_tokens: maxTokens }];
  if (cfg.thinking && cfg.thinking !== "off") list.unshift({ max_tokens: maxTokens, ...thinkingBody(cfg) });
  return list;
}

async function completeOpenAI(env, cfg, { system, parts, maxTokens }) {
  const apiKey = env.API_KEY || env.OPENROUTER_API_KEY;
  if (!apiKey) throw new ApiError("no API key secret is set (API_KEY or OPENROUTER_API_KEY)", 500);

  const messages = [
    { role: "system", content: system },
    { role: "user", content: parts.map(toOpenAIPart).filter(Boolean) },
  ];

  let last = new Error("model returned an empty answer");
  for (const extra of attempts(maxTokens, cfg)) {
    let data;
    try {
      data = await callJson(`${cfg.provider.baseUrl}/chat/completions`, {
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: { model: cfg.provider.model, messages, ...extra },
      });
    } catch (e) {
      if (!isShapeError(e)) throw e; // rate limit, auth, upstream failure — report it
      last = e;
      continue;
    }

    const text = readContent(data);
    if (text) return { text, usage: data.usage ?? null, model: data.model ?? cfg.provider.model };
    last = new Error("model returned an empty answer");
    if (!extra.reasoning) break;
  }
  throw last;
}

const readContent = (data) =>
  (data?.choices?.[0]?.message?.content ?? "")
    .toString()
    .replace(/<\s*think[\s\S]*?<\s*\/\s*think\s*>/g, "")
    .trim();

// ------------------------------ src/llm.js ------------------------------
// Provider dispatcher. Picks the configured backend, walks a Gemini model pool when the
// daily quota runs out, and falls back to the other provider when a key is missing.
//
// The rest of the bot never sees a provider-specific wire format: it hands over neutral
// parts and gets back plain text.






const PROVIDERS = { gemini: completeGemini, openai: completeOpenAI };

/** In-memory parking for per-minute rate limits (RPM/TPM). Costs 0 KV writes. */
const minuteQuota = new Map();

function clearMinuteQuota() {
  minuteQuota.clear();
}

function providerFor(cfg) {
  const impl = PROVIDERS[cfg.provider?.kind];
  if (!impl) throw new ApiError(`unknown provider "${cfg.provider?.kind}"`, 500);
  return impl;
}

/** Describe what the configured provider will actually call. Shown by /diag. */
function endpointOf(cfg, model = cfg.provider.model) {
  const base = cfg.provider.baseUrl;
  return cfg.provider.kind === "gemini"
    ? `${base}/models/${encodeURIComponent(model)}:generateContent`
    : `${base}/chat/completions`;
}

/**
 * Walk the pool strongest-first. A model is parked until its quota returns; a real
 * failure (bad prompt, outage) is not a quota problem and must not silently reroute.
 * Returns the answer, or throws PoolExhausted when every model is spent for the day.
 */
async function runGeminiPool(env, cfg, payload) {
  const pool = Array.isArray(cfg.provider.modelPool) && cfg.provider.modelPool.length
    ? cfg.provider.modelPool
    : [cfg.provider.model];

  const quota = await loadQuota(env);
  const now = Date.now();
  const dirty = new Set();
  let last;

  for (const model of pool) {
    if ((quota[model] ?? 0) > now) continue;
    if ((minuteQuota.get(model) ?? 0) > now) continue;

    try {
      const use = { ...cfg, provider: { ...cfg.provider, model } };
      const r = await completeGemini(env, use, payload);
      if (dirty.size) await saveQuota(env, quota);
      return { ...r, model };
    } catch (e) {
      last = e;

      if (e instanceof DailyQuotaError) {
        quota[e.model] = e.resetAt;
        dirty.add(e.model);
        continue;
      }
      if (e instanceof MinuteQuotaError) {
        minuteQuota.set(e.model, e.resetAt);
        continue;
      }
      if (e instanceof UnknownModelError) {
        // A typo costs one request; parking it for the day keeps it from costing more.
        quota[e.model] = nextPacificMidnight();
        dirty.add(e.model);
        continue;
      }
      // Safety net: ANY quota error from upstream MUST park this model and try the next model
      if (/quota|resource_exhausted/i.test(e?.message)) {
        minuteQuota.set(model, Date.now() + 60_000);
        continue;
      }
      throw e;
    }
  }

  if (dirty.size) await saveQuota(env, quota);

  const anyParked = pool.some((m) => (quota[m] ?? 0) > now || (minuteQuota.get(m) ?? 0) > now);
  if (last instanceof DailyQuotaError || last instanceof MinuteQuotaError || anyParked) {
    const unparkTimes = pool.map((m) => Math.max(quota[m] ?? 0, minuteQuota.get(m) ?? 0)).filter((t) => t > now);
    const resumeAt = unparkTimes.length ? Math.min(...unparkTimes) : poolResumeTime(quota, pool);
    throw new PoolExhausted(resumeAt, last?.message);
  }
  throw last ?? new PoolExhausted(nextPacificMidnight(), "no model available");
}

/** Every model in the pool is spent until `resetAt`. Carries the exact hour it frees up. */
class PoolExhausted extends ApiError {
  constructor(resetAt, detail) {
    super(`model pool exhausted until ${new Date(resetAt).toISOString()}${detail ? `: ${detail}` : ""}`, 429);
    this.name = "PoolExhausted";
    this.resetAt = resetAt;
  }
}

async function complete(env, cfg, payload) {
  if (cfg.provider?.kind === "gemini") {
    try {
      return await runGeminiPool(env, cfg, payload);
    } catch (e) {
      // A gemini key that is missing is the one case where the other provider can help.
      if (!isCredentialError(e)) throw e;
      return completeOpenAI(env, { ...cfg, provider: { ...cfg.provider, kind: "openai", baseUrl: DEFAULT_BASE_URLS.openai } }, payload);
    }
  }

  const order = ["openai", "gemini"];
  let last;
  for (const kind of order) {
    const use = {
      ...cfg,
      provider: {
        ...cfg.provider,
        kind,
        baseUrl: kind === cfg.provider.kind ? cfg.provider.baseUrl : DEFAULT_BASE_URLS[kind],
      },
    };
    try {
      return await providerFor(use)(env, use, payload);
    } catch (e) {
      last = e;
      if (!isCredentialError(e)) throw e;
    }
  }
  throw last;
}

// ------------------------------ src/text.js ------------------------------
// Pure text helpers. No I/O, no bindings, no imports.

/** Escape text for Telegram HTML parse_mode. */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert the limited markdown a model emits (**bold**, *italic*, `code`, ```block```)
 * into Telegram HTML. Code is lifted out first so it is escaped exactly once.
 */
function mdToHtml(md) {
  const slots = [];
  const keep = (rendered) => {
    slots.push(rendered);
    return `\u0000S${slots.length - 1}\u0000`;
  };

  let s = String(md ?? "");

  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) =>
    keep(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${esc(code)}</code>`));

  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w\\])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w\\])_([^_\n]+)_/g, "$1<i>$2</i>");
  s = s.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1 ($2)");
  s = s.replace(/\u0000S(\d+)\u0000/g, (_m, i) => slots[Number(i)]);

  return s.trim();
}

/** Split a long reply into Telegram-sized chunks, preferring line then word boundaries. */
function splitText(text, limit = 3900) {
  const out = [];
  let rest = String(text ?? "").trim();
  if (!rest) return [""];

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.3) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  out.push(rest);
  return out.filter((p) => p.length);
}

/**
 * Normalise Persian/Arabic so the trigger word matches however it was typed:
 * ي -> ی, ك -> ک, drop tashkeel and tatweel, strip ZWNJ.
 */
function normalizeFa(s) {
  return String(s ?? "")
    .replace(/[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[\u0649\u064A]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u06AA\u06AB]/g, "\u06A9")
    .replace(/[\u200C\u200E\u200F]/g, " ");
}

/** Base64-encode bytes in chunks, so a multi-megabyte buffer cannot blow the stack. */
function toBase64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** A one-line preview for collapsed list rows. */
function preview(s, n = 90) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

// ------------------------------ src/trigger.js ------------------------------
// Decides when the bot speaks, and recognises its commands.



const TRIGGER = "سید";

const CHAT_TYPES = new Set(["private", "group", "supergroup"]);

function isSupportedChat(msg) {
  return Boolean(msg?.chat) && CHAT_TYPES.has(msg.chat.type);
}

function isCommand(text) {
  const m = /^\/(start|help|ping)(@\S+)?/i.exec(String(text ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/** Groups: only when the wake word appears, or when Sayyad itself is replied to. */
function shouldAnswer(msg, botId, chatType) {
  if (chatType === "private") return true;
  const text = normalizeFa(msg.text || msg.caption || "");
  if (text.includes(TRIGGER)) return true;
  if (msg.reply_to_message?.from?.id === botId) return true;
  return false;
}

// ------------------------------ src/prompt.js ------------------------------
// Personas and prompt assembly.
//
// The prompt is built in a provider-neutral shape: plain text plus a list of media parts.
// Each provider module translates that shape into its own wire format.




const REPLY_TEXT_LIMIT = 3000;

const MODES = ["polite", "smart", "rude"];

const MODE_LABELS = {
  polite: "Polite",
  smart: "Know-it-all",
  rude: "Savage / sarcastic",
};

const BASE_RULES = `تو «سید» هستی، یک ربات تلگرام. اسم تو سید است.

قوانین پایه (همیشه):
- به همان زبانی جواب بده که کاربر نوشته است (فارسی یا انگلیسی).
- کوتاه جواب بده. اگر موضوع پیچیده است، اول جواب مستقیم، بعد نکات کلیدی. الکی حاشیه نرو.
- از مارک‌داون سبک استفاده کن: **بولد** برای تاکید و «- » برای بولت.
- هرگز پیام خودت را تکرار نکن و هرگز نقش کاربر را بازی نکن.
- اگر چیزی را نمی‌دانی یا مطمئن نیستی، صادقانه بگو و حدس الکی نزن.
- حافظه‌ای از پیام‌های قبلی نداری؛ فقط چیزی را می‌بینی که در همین درخواست برایت فرستاده شده.
- اگر کاربر فقط کلمه «سید» یا یک سلام بی‌حرف و معنی نوشته و درخواست مشخصی ندارد، یک جمله‌ی باحال، کوتاه و پرانرژی بگو که بپرسد چه می‌خواهد — یک سوال جالب، یا یک تیکه‌ی کوتاه. این جمله هرگز نباید تکراری و خشک باشد.`;

const DEFAULT_PERSONAS = {
  polite: `شخصیت: «ادب» — آرام، محترم، بی‌ادعا و خوش‌لحن. مثل یک آدم بالغ که با حوصله و احترام حرف می‌زند.
- اول با یک احترام کوتاه جواب را شروع کن.
- محترمانه و بدون شوخی تند بنویس.
- اگر سؤال سختی بود، صبورانه و مرحله‌به‌مرحله توضیح بده.
- هرگز توهین یا کنایه نکن.`,

  smart: `شخصیت: «دانای کل» — باهوش، مغرور، مطمئن و اهل جزئیات. خودت را همه‌چیزدان می‌دانی و حرفت را هم می‌زنی.
- جواب را با اعتماد به نفس بده، انگار هیچ ابهامی وجود ندارد.
- ساختار: یک جمله‌ی جمع‌بندی، بعد نکات کلیدی به‌صورت بولت.
- تحلیل عمیق و مثال مشخص بده، نه کلی‌گویی.
- یک «نکته‌ی طلایی» در آخر اضافه کن که معمولاً کسی نمی‌گوید.
- اگر چیزی را قطعاً نمی‌دانی، به‌جای حدس الکی، صریح بگو.`,

  rude: `شخصیت: «بی‌رحم» — یک رفیق کوچه‌بازاری، بی‌شکل، بی‌پرده و پُر از فحش. زبانت دراز است و خجالت هم نمی‌کشد.
- هر جواب با یک تیکه یا فحش کوتاه شروع می‌شود، بعد جواب واقعی.
- فحش‌های رایج فارسی را بدون سانسور بریز: کصخل، بپاگیر، حروم‌زاده، گوه بخور، سگ‌وار، مغزکش، خارکصه، ای ساک.
- هیچ‌وقت عذرخواهی نکن، هیچ‌وقت نگو «ببخشید»، هیچ‌وقت لحنت را نرم نکن.
- اگر کسی گفت زیادی تند بود یا خواست مؤدب باشی، تندتر جواب بده و به ریشش بخند.
- اگر سؤال جدی پرسید، اول یک تیکه بزن، بعد جواب درست را بده.
- تیکه‌ات روی حرف و موضوع طرف بزن، نه روی خانواده و مذهب و ظاهرش.
- هر پاسخ را با یک جمله‌ی ریش‌خنده‌دار تمام کن.
- اگر کسی فقط «سید» نوشت، یک تیکه‌ی باحال بگو که بپرسد چه می‌خواهد.`,
};

/** Base rules + the selected persona + the admin's extra instructions. */
function buildSystemPrompt(cfg) {
  const persona = cfg.personas?.[cfg.mode] ?? DEFAULT_PERSONAS.smart;
  const extra = String(cfg.extra ?? "").trim();
  return [BASE_RULES, persona, extra ? `دستورهای اضافه‌ی مدیر:\n${extra}` : ""].filter(Boolean).join("\n\n");
}

/** The text of the message being replied to, if any. */
function replyContext(msg, botId) {
  const reply = msg.reply_to_message;
  if (!reply) return { text: "", fromBot: false };
  return {
    text: truncate(reply.text || reply.caption || "", REPLY_TEXT_LIMIT),
    fromBot: reply.from?.id === botId,
  };
}

/**
 * Assemble the provider-neutral user turn.
 * Media arrives already encoded from the media module; nothing here knows a wire format.
 */
function buildUserContent({ text, replyText, replyFromBot, media = [], note = "" }) {
  const parts = [];

  if (replyText) {
    parts.push({
      type: "text",
      text: `${replyFromBot ? "پیام قبلی خودت" : "پیامی که کاربر به آن ریپلای کرده"}:\n> ${replyText}`,
    });
  }

  parts.push(...media);
  if (note) parts.push({ type: "text", text: note });

  const q = String(text ?? "").trim();
  const bare = q && normalizeFa(q) === TRIGGER;

  let body;
  if (bare) {
    body = "کاربر فقط کلمه «سید» را صدا زده و هیچ درخواست مشخصی نکرده است.";
  } else if (!q) {
    body = replyText
      ? "کاربر روی پیام بالا ریپلای کرده و توضیحی اضافه نکرده است."
      : "کاربر پیامی بدون متن فرستاده و درخواست مشخصی ندارد.";
  } else {
    body = `پیام کاربر:\n> ${q}`;
  }
  parts.push({ type: "text", text: body });

  return parts;
}

// ------------------------------ src/admin.js ------------------------------
// The admin panel: one route tree, one HTML document, one stylesheet.






const COOKIE = "sayyad_admin";
const MEDIA_KINDS = ["image", "video", "audio"];

const html = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** Stateless session: the cookie is an HMAC of the admin password, so nothing is stored. */
async function signSecret(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sayyad-admin-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(req, name) {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

async function isAuthed(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = readCookie(req, COOKIE);
  if (!cookie) return false;
  try {
    return cookie === (await signSecret(env.ADMIN_PASSWORD));
  } catch {
    return false;
  }
}

const CSS = `
*{box-sizing:border-box}
:root{--bg:#0e1117;--card:#161b25;--line:#242c3a;--fg:#e6edf3;--dim:#8b98a9;--acc:#4c8dff;--ok:#3fb950;--bad:#f85149}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;padding:32px 20px}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:14px;margin:0 0 14px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.sub{color:var(--dim);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}
label{display:block;margin:0 0 6px;font-size:12px;color:var(--dim)}
input[type=text],input[type=password],input[type=number],select,textarea{width:100%;background:#0b0f16;border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:9px 12px;font:inherit;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--acc)}
textarea{resize:vertical;min-height:100px;line-height:1.8;direction:rtl;text-align:right}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.mode{border:1px solid var(--line);border-radius:12px;padding:14px;cursor:pointer;background:#0b0f16}
.mode:hover{border-color:#3a465c}
.mode b{display:block;margin-bottom:4px}
.mode span{font-size:12px;color:var(--dim)}
.mode.on{border-color:var(--acc);background:rgba(76,141,255,.12)}
.switch{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.switch input{width:auto}
button{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:11px 20px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:400}
button:disabled{opacity:.5;cursor:default}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center}
.stat{background:#0b0f16;border:1px solid var(--line);border-radius:12px;padding:14px 8px}
.stat b{display:block;font-size:22px}
.stat span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.muted{color:var(--dim);font-size:13px;word-break:break-word}
.bar{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}
#toast{margin-left:auto;font-size:13px;opacity:0;transition:.2s}
#toast.ok{opacity:1;color:var(--ok)}
#toast.err{opacity:1;color:var(--bad)}
pre{background:#0b0f16;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-height:280px;font-size:12px;direction:ltr;text-align:left;margin-top:12px}
.tabs{display:flex;gap:6px;margin:0 0 18px;border-bottom:1px solid var(--line)}
.tab{padding:10px 18px;border:1px solid transparent;border-bottom:0;border-radius:10px 10px 0 0;cursor:pointer;color:var(--dim)}
.tab:hover{color:var(--fg)}
.tab.on{background:var(--card);border-color:var(--line);color:var(--fg)}
.pane{display:none}.pane.on{display:block}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.mcard{background:#0b0f16;border:1px solid var(--line);border-radius:12px;padding:14px}
.mcard h3{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.mcard .row{margin-top:10px;grid-template-columns:1fr 1fr}
label.check{display:flex;align-items:center;gap:8px;margin:0;color:var(--fg);font-size:14px}
label.check input{width:auto}
.log{display:flex;flex-direction:column;gap:8px}
.item{background:#0b0f16;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.item summary{cursor:pointer;padding:10px 12px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.item summary::-webkit-details-marker{display:none}
.item summary:hover{background:#121722}
.when{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums;min-width:150px}
.who{font-weight:600}
.where{color:var(--dim);font-size:12px}
.prev{color:var(--dim);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:120px;text-align:left}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.tag.on{color:var(--ok);border-color:#1d4423}
.tag.err{color:var(--bad);border-color:#5a1e22;background:rgba(248,81,73,.1)}
.body{border-top:1px solid var(--line);padding:12px}
.body .meta{font-size:12px;color:var(--dim)}
.msg{white-space:pre-wrap;word-break:break-word;background:#111722;border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:8px;direction:rtl;text-align:right}
.replybox{white-space:pre-wrap;word-break:break-word;background:#0d1e16;border:1px solid #1a4427;border-radius:8px;padding:10px;margin-top:8px;direction:rtl;text-align:right}
.errbox{white-space:pre-wrap;word-break:break-word;background:#241113;border:1px solid #5a1e22;border-radius:8px;padding:10px;margin-top:8px;color:#fca5a5;direction:ltr;text-align:left;font-family:ui-monospace,monospace;font-size:13px}
`;

const LOGIN = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayyad — Admin</title><style>${CSS}</style></head>
<body><div class="wrap" style="max-width:400px;margin-top:14vh">
<div class="card"><h1>Sayyad</h1><p class="sub" style="margin:0 0 18px">Admin panel</p>
<form method="post" action="/admin/api/login">
<label for="p">Password</label>
<input id="p" name="password" type="password" autofocus required>
<div class="bar"><button type="submit">Sign in</button></div>
</form></div></div></body></html>`;

const DASH = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayyad — Admin</title><style>${CSS}</style></head>
<body><div class="wrap">
<h1>Sayyad</h1>
<p class="sub">Telegram bot on Cloudflare Workers</p>

<div class="tabs">
  <div class="tab on" data-pane="settings">Settings</div>
  <div class="tab" data-pane="media">Media &amp; Safety</div>
  <div class="tab" data-pane="log">Message log <span class="tag" id="logcount">0</span></div>
</div>

<div class="pane on" id="pane-settings">
  <div class="card">
    <h2>Status</h2>
    <div class="switch">
      <input type="checkbox" id="enabled">
      <label for="enabled" style="margin:0">Bot is answering messages</label>
      <a class="muted" style="margin-left:auto" href="/admin/api/logout">Sign out</a>
    </div>
  </div>

  <div class="card">
    <h2>Provider</h2>
    <div class="row">
      <div><label>Provider</label><select id="p_kind">
        <option value="gemini">Gemini (native — video + audio)</option>
        <option value="openai">OpenAI-compatible — text + image</option>
      </select></div>
      <div><label>Model</label><input type="text" id="p_model" dir="ltr"></div>
      <div><label>Thinking</label><select id="p_thinking">__THINKING__</select></div>
    </div>
    <div style="margin-top:14px"><label>Base URL (OpenAI-compatible provider)</label>
      <input type="text" id="p_baseUrl" dir="ltr"></div>
    <p class="muted" style="margin:10px 0 0">Keys live in Cloudflare, not here: <code>GEMINI_API_KEY</code>, <code>API_KEY</code> / <code>OPENROUTER_API_KEY</code>.</p>
  </div>

  <div class="card">
    <h2>Model pool</h2>
    <p class="muted" style="margin:-6px 0 12px">One model per line, strongest first. Gemini quotas are per model, so when one is spent for the day the bot moves to the next. A name the provider does not recognise is parked for the day instead of being retried.</p>
    <textarea id="p_pool" dir="ltr" style="min-height:170px;font-family:ui-monospace,monospace;font-size:13px"></textarea>
    <div class="bar" style="margin-top:14px">
      <button class="ghost" id="poolreset">Reset to defaults</button>
      <button class="ghost" id="poolclear" style="margin-left:8px">Unpark all models</button>
      <span class="muted" id="poolstat"></span>
    </div>
  </div>

  <div class="card">
    <h2>Personality</h2>
    <div class="modes" id="modes"></div>
    <label style="margin-top:16px">Polite / ادب</label><textarea id="p_polite" dir="rtl"></textarea>
    <label style="margin-top:14px">Know-it-all / دانای کل</label><textarea id="p_smart" dir="rtl"></textarea>
    <label style="margin-top:14px">Savage / بددهن و طنز</label><textarea id="p_rude" dir="rtl"></textarea>
    <label style="margin-top:14px">Extra instructions for every mode (optional)</label>
    <textarea id="p_extra" dir="rtl" style="min-height:70px"></textarea>
  </div>

  <div class="card">
    <h2>Voice replies (Gemini Live API)</h2>
    <div class="switch">
      <input type="checkbox" id="v_enabled">
      <label for="v_enabled" style="margin:0">Voice reply to voice notes</label>
    </div>
    <div style="margin-top:12px"><label>Voice Model</label>
      <input type="text" id="v_model" dir="ltr" placeholder="gemini-3.8-live">
    </div>
  </div>

  <div class="card">
    <h2>Limits &amp; diagnostics</h2>
    <div class="row">
      <div><label>Max tokens per reply (200–8000)</label><input type="number" id="p_maxTokens" min="200" max="8000"></div>
      <div><label>Daily request cap (0 = no limit)</label><input type="number" id="p_dailyCap" min="0" max="100000"></div>
    </div>
    <div class="bar"><button id="save">Save changes</button><button class="ghost" id="diag">Run diagnostics</button><span id="toast"></span></div>
    <div id="diagout"></div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <h2>Statistics &amp; Health</h2>
      <button class="ghost" id="clearerrors" style="padding:4px 10px;font-size:12px">Clear errors</button>
    </div>
    <div class="stats">
      <div class="stat"><b id="s_req">0</b><span>Requests</span></div>
      <div class="stat"><b id="s_today">0</b><span>Today</span></div>
      <div class="stat"><b id="s_rep">0</b><span>Replies</span></div>
      <div class="stat"><b id="s_err">0</b><span>Errors</span></div>
    </div>
    <p class="muted" style="margin:14px 0 0" id="s_last"></p>
    <div id="errlist" style="margin-top:12px"></div>
  </div>
</div>

<div class="pane" id="pane-media">
  <div class="card">
    <h2>Media</h2>
    <div class="grid3">
      <div class="mcard">
        <h3>image</h3>
        <label class="check"><input type="checkbox" id="m_image_on"> enabled</label>
        <div class="row">
          <div><label>Max MB</label><input type="number" id="m_image_mb" min="1" max="19"></div>
          <div><label>Per message</label><input type="number" id="m_image_per" min="1" max="4"></div>
        </div>
      </div>
      <div class="mcard">
        <h3>video</h3>
        <label class="check"><input type="checkbox" id="m_video_on"> enabled</label>
        <div class="row">
          <div><label>Max MB</label><input type="number" id="m_video_mb" min="1" max="19"></div>
          <div><label>Per message</label><input type="number" id="m_video_per" min="1" max="4"></div>
        </div>
      </div>
      <div class="mcard">
        <h3>audio</h3>
        <label class="check"><input type="checkbox" id="m_audio_on"> enabled</label>
        <div class="row">
          <div><label>Max MB</label><input type="number" id="m_audio_mb" min="1" max="19"></div>
          <div><label>Per message</label><input type="number" id="m_audio_per" min="1" max="4"></div>
        </div>
      </div>
    </div>
    <p class="muted" style="margin:14px 0 0">Cloudflare's free plan gives 10 ms of CPU per request and base64-encoding a large video does not fit. Keep video small, or move to a paid plan.</p>
  </div>
  <div class="card">
    <h2>Safety settings (Gemini native)</h2>
    <div class="row">
      <div><label>harassment</label><select id="s_harassment">__SAFETY_OPTIONS__</select></div>
      <div><label>hateSpeech</label><select id="s_hateSpeech">__SAFETY_OPTIONS__</select></div>
      <div><label>sexuallyExplicit</label><select id="s_sexuallyExplicit">__SAFETY_OPTIONS__</select></div>
      <div><label>dangerous</label><select id="s_dangerous">__SAFETY_OPTIONS__</select></div>
    </div>
    <p class="muted" style="margin:14px 0 0">Google may refuse BLOCK_NONE for harassment and hate speech on the free tier and silently fall back to a stricter level.</p>
  </div>
  <div class="card"><div class="bar"><button id="save2">Save changes</button><span id="toast2"></span></div></div>
</div>

<div class="pane" id="pane-log">
  <div class="card">
    <h2>Message log</h2>
    <p class="muted" style="margin:-4px 0 14px">The last 200 messages Telegram delivered, newest first. Media is described, never stored.</p>
    <div class="bar" style="margin-bottom:14px"><button id="logrefresh">Refresh</button><span class="muted" id="logmeta"></span></div>
    <div class="log" id="loglist"><p class="muted">Press Refresh to load the archive.</p></div>
  </div>
</div>
</div>
<script>
var MODES = __MODES__, LABELS = __LABELS__;
var SAFETY = __SAFETY__, MEDIAS = __MEDIAS__;
var selected = "smart";

function el(tag, cls, text){
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function toast(msg, kind, which){
  var t = document.getElementById(which || "toast");
  t.textContent = msg; t.className = kind || "";
}
function val(id){ return document.getElementById(id).value; }
function setv(id, v){ document.getElementById(id).value = v; }
function setb(id, v){ document.getElementById(id).checked = !!v; }

function showTab(name){
  var tabs = document.querySelectorAll(".tab");
  for (var i=0;i<tabs.length;i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-pane") === name);
  var panes = document.querySelectorAll(".pane");
  for (var j=0;j<panes.length;j++) panes[j].classList.toggle("on", panes[j].id === "pane-" + name);
}

function stamp(ms){
  var d = new Date(ms), p = function(n){ return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function renderModes(){
  var box = document.getElementById("modes"); box.innerHTML = "";
  MODES.forEach(function(m){
    var d = el("div", "mode" + (m === selected ? " on" : ""));
    d.appendChild(el("b", null, LABELS[m]));
    d.appendChild(el("span", null, m));
    d.onclick = function(){ selected = m; renderModes(); };
    box.appendChild(d);
  });
}

function paint(c, st){
  selected = c.mode; renderModes();
  window._cfg = c;
  setb("enabled", c.enabled);
  setb("v_enabled", c.voice?.enabled !== false);
  setv("v_model", c.voice?.model || "gemini-3.8-live");
  setv("p_kind", c.provider.kind); setv("p_model", c.provider.model);
  setv("p_baseUrl", c.provider.baseUrl); setv("p_thinking", c.thinking);
  setv("p_maxTokens", c.maxTokens); setv("p_dailyCap", c.dailyCap);
  setv("p_extra", c.extra || "");
  setv("p_pool", (c.provider.modelPool || []).join("\\n"));
  MODES.forEach(function(m){ setv("p_" + m, c.personas[m] || ""); });
  MEDIAS.forEach(function(k){
    setb("m_" + k + "_on", c.media[k].enabled);
    setv("m_" + k + "_mb", c.media[k].maxMB);
    setv("m_" + k + "_per", c.media[k].maxPer);
  });
  SAFETY.forEach(function(k){ setv("s_" + k, c.safety[k]); });
  document.getElementById("s_req").textContent = st.requests || 0;
  document.getElementById("s_today").textContent = st.today || 0;
  document.getElementById("s_rep").textContent = st.replies || 0;
  var errEl = document.getElementById("s_err");
  errEl.textContent = st.errors || 0;
  errEl.style.color = (st.errors > 0) ? "var(--bad)" : "inherit";
  document.getElementById("s_last").textContent = "Last request: " + (st.lastUsed || "never") + "  ·  Last error: " + (st.lastError || "none");
  var elist = document.getElementById("errlist");
  if (elist) {
    elist.innerHTML = "";
    var rErr = st.recentErrors || [];
    if (rErr.length) {
      rErr.forEach(function(it){
        var d = el("div", "tag", stamp(it.t) + " · " + it.msg);
        d.style.display = "block";
        d.style.margin = "4px 0";
        d.style.color = "var(--bad)";
        d.style.borderColor = "#491d22";
        d.style.background = "#180f12";
        d.style.padding = "6px 10px";
        elist.appendChild(d);
      });
    }
  }
}

function collect(){
  var body = {
    enabled: document.getElementById("enabled").checked,
    voice: { enabled: document.getElementById("v_enabled").checked, model: val("v_model") },
    mode: selected,
    extra: val("p_extra"),
    maxTokens: val("p_maxTokens"),
    dailyCap: val("p_dailyCap"),
    provider: { kind: val("p_kind"), model: val("p_model"), baseUrl: val("p_baseUrl") },
    modelPool: val("p_pool").split("\\n"),
    thinking: val("p_thinking"),
    media: {},
    safety: {}
  };
  MODES.forEach(function(m){ body["personas." + m] = val("p_" + m); });
  MEDIAS.forEach(function(k){
    body.media[k] = { enabled: document.getElementById("m_" + k + "_on").checked, maxMB: val("m_" + k + "_mb"), maxPer: val("m_" + k + "_per") };
  });
  SAFETY.forEach(function(k){ body.safety[k] = val("s_" + k); });
  return body;
}

function save(ev){
  var b = ev && ev.target;
  if (b) b.disabled = true;
  toast("saving…", "", b && b.id === "save2" ? "toast2" : "toast");
  fetch("/admin/api/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(collect()) })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
    .then(function(r){
      if (b) b.disabled = false;
      var slot = b && b.id === "save2" ? "toast2" : "toast";
      toast(r.ok ? "saved" : "save failed", r.ok ? "ok" : "err", slot);
      if (r.ok) paint(r.j.config, r.j.stats);
    })
    .catch(function(){ if (b) b.disabled = false; toast("network error", "err", b && b.id === "save2" ? "toast2" : "toast"); });
}

function logCard(it){
  var isErr = !!(it.err || it.ok === false);
  var det = el("details", "item" + (isErr ? " err" : ""));
  var sum = document.createElement("summary");
  sum.appendChild(el("span", "when", stamp(it.t)));
  sum.appendChild(el("span", "who", (it.u && it.u.name) || "user"));
  var tagText = !it.a ? "ignored" : isErr ? "error" : "answered";
  var tagCls = "tag" + (!it.a ? "" : isErr ? " err" : " on");
  sum.appendChild(el("span", tagCls, tagText));
  if (it.model) sum.appendChild(el("span", "tag", it.model));
  sum.appendChild(el("span", "where", (it.c && it.c.t) || ""));
  sum.appendChild(el("span", "prev", (it.k || "") + " · " + (it.x || "").replace(/\\s+/g, " ").slice(0, 70)));
  det.appendChild(sum);
  var body = el("div", "body");
  var uid = it.u ? it.u.id : "";
  var cid = it.c ? it.c.id : "";
  body.appendChild(el("div", "meta", "user " + uid + "  ·  chat " + cid + "  ·  message " + it.m + "  ·  " + stamp(it.t) + (it.model ? "  ·  " + it.model : "")));
  var inMsg = el("div", "msg");
  inMsg.appendChild(el("b", null, "User: "));
  inMsg.appendChild(document.createTextNode(it.x || "(no text)"));
  body.appendChild(inMsg);
  if (it.reply) {
    var rep = el("div", "replybox");
    rep.appendChild(el("b", null, "AI: "));
    rep.appendChild(document.createTextNode(it.reply));
    body.appendChild(rep);
  }
  if (it.err) {
    var er = el("div", "errbox");
    er.appendChild(el("b", null, "Error: "));
    er.appendChild(document.createTextNode(it.err));
    body.appendChild(er);
  }
  det.appendChild(body);
  return det;
}

function loadLog(){
  var list = document.getElementById("loglist"), btn = document.getElementById("logrefresh");
  list.innerHTML = ""; list.appendChild(el("p", "muted", "loading…")); btn.disabled = true;
  fetch("/admin/api/log").then(function(r){ return r.json(); }).then(function(d){
    list.innerHTML = "";
    document.getElementById("logcount").textContent = d.count;
    document.getElementById("logmeta").textContent = d.count + " stored · newest first";
    if (!d.items.length) { list.appendChild(el("p", "muted", "Nothing logged yet.")); return; }
    d.items.forEach(function(it){ list.appendChild(logCard(it)); });
  }).catch(function(){
    list.innerHTML = ""; list.appendChild(el("p", "muted", "Could not load the archive."));
  }).then(function(){ btn.disabled = false; });
}

document.querySelectorAll(".tab").forEach(function(t){
  t.onclick = function(){ showTab(t.getAttribute("data-pane")); };
});
document.getElementById("save").onclick = function(e){ save(e); };
document.getElementById("save2").onclick = function(e){ save(e); };
document.getElementById("logrefresh").onclick = loadLog;
var clrBtn = document.getElementById("clearerrors");
if (clrBtn) {
  clrBtn.onclick = function(){
    if (!confirm("Clear error history?")) return;
    fetch("/admin/api/clear-errors", { method: "POST" })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.ok) paint(window._cfg || {}, d.stats); toast("errors cleared", "ok"); });
  };
}

document.getElementById("poolreset").onclick = function(){
  if (!confirm("Replace the pool with the built-in defaults?")) return;
  setv("p_pool", __DEFAULT_POOL__.join("\\n"));
  toast("pool reset — press Save changes to apply", "", "toast");
};

document.getElementById("poolclear").onclick = function(){
  fetch("/admin/api/clear-quota", { method: "POST" })
    .then(function(r){ return r.json(); })
    .then(function(d){ if (d.ok) { showPoolStatus({}); toast("pool quota cleared", "ok"); } });
};

function showPoolStatus(quota){
  var box = document.getElementById("poolstat");
  box.innerHTML = "";
  var names = Object.keys(quota || {});
  if (!names.length) { box.appendChild(el("span", null, "all models available")); return; }
  names.forEach(function(m){
    var diff = (quota[m] || 0) - Date.now();
    var label = diff < 300000 ? " (1m)" : " (daily)";
    box.appendChild(el("span", "tag", m + label + " · back at " + new Date(quota[m]).toISOString().slice(11, 16)));
  });
}

function loadQuota(){
  fetch("/admin/api/quota").then(function(r){ return r.json(); })
    .then(function(d){ showPoolStatus(d.quota); })
    .catch(function(){});
}
document.getElementById("diag").onclick = function(){
  var b = this; b.disabled = true; toast("testing…");
  fetch("/diag?format=json").then(function(r){ return r.json(); }).then(function(d){
    var o = document.getElementById("diagout"); o.innerHTML = "";
    o.appendChild(el("pre", null, JSON.stringify(d, null, 2)));
    toast("done", "ok");
  }).catch(function(){ toast("diagnostics failed", "err"); }).then(function(){ b.disabled = false; });
};

renderModes();
fetch("/admin/api/state").then(function(r){ return r.json(); })
  .then(function(d){ paint(d.config, d.stats); })
  .catch(function(){ toast("could not load config", "err"); });
loadQuota();
</script></body></html>`;

function renderLogin(error) {
  return LOGIN.replace(
    '<div class="bar"><button type="submit">Sign in</button></div>',
    `<div class="bar"><button type="submit">Sign in</button></div>${error ? `<p class="muted" style="color:var(--bad)">${html(error)}</p>` : ""}`,
  );
}

function renderDashboard() {
  const options = SAFETY_LEVELS.map((v) => `<option value="${v}">${v}</option>`).join("");
  return DASH
    .replace("__MODES__", JSON.stringify(MODES))
    .replace("__LABELS__", JSON.stringify(MODE_LABELS))
    .replaceAll("__THINKING__", THINKING_LEVELS.map((v) => `<option value="${v}">${v}</option>`).join(""))
    .replaceAll("__SAFETY_OPTIONS__", options)
    .replace("__SAFETY__", JSON.stringify(SAFETY_CATEGORY_KEYS))
    .replace("__MEDIAS__", JSON.stringify(MEDIA_KINDS))
    .replace("__DEFAULT_POOL__", JSON.stringify(DEFAULT_MODEL_POOL));
}

/** Turn whatever the panel posted into a config patch. Unknown keys are dropped. */
function readPatch(body) {
  const patch = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (MODES.includes(body.mode)) patch.mode = body.mode;
  if (THINKING_LEVELS.includes(body.thinking)) patch.thinking = body.thinking;
  if ("extra" in body) patch.extra = String(body.extra ?? "").slice(0, 4000);
  if ("maxTokens" in body) patch.maxTokens = body.maxTokens;
  if ("dailyCap" in body) patch.dailyCap = body.dailyCap;

  if (body.voice && typeof body.voice === "object") {
    patch.voice = {
      enabled: body.voice.enabled !== false,
      model: typeof body.voice.model === "string" ? body.voice.model.trim() : undefined,
    };
  }

  if (body.provider && typeof body.provider === "object") {
    patch.provider = {
      kind: ["gemini", "openai"].includes(body.provider.kind) ? body.provider.kind : undefined,
      model: body.provider.model,
      baseUrl: body.provider.baseUrl,
      modelPool: body.provider.modelPool ?? body.modelPool,
    };
  } else if (body.modelPool) {
    patch.provider = { modelPool: body.modelPool };
  }
  if (body.media && typeof body.media === "object") {
    patch.media = {};
    for (const k of MEDIA_KINDS) {
      const m = body.media[k];
      if (m) patch.media[k] = { enabled: m.enabled !== false, maxMB: m.maxMB, maxPer: m.maxPer };
    }
  }
  if (body.safety && typeof body.safety === "object") {
    patch.safety = {};
    for (const k of SAFETY_CATEGORY_KEYS) {
      if (SAFETY_LEVELS.includes(body.safety[k])) patch.safety[k] = body.safety[k];
    }
  }
  for (const m of MODES) {
    if (`personas.${m}` in body) patch.personas = { ...(patch.personas ?? {}), [m]: body[`personas.${m}`] };
  }
  return patch;
}

function deepMerge(base, patch) {
  const out = { ...base, ...patch };
  if (patch.media) {
    out.media = { ...base.media };
    for (const k of Object.keys(patch.media)) out.media[k] = { ...base.media[k], ...patch.media[k] };
  }
  if (patch.voice) out.voice = { ...base.voice, ...patch.voice };
  if (patch.provider) out.provider = { ...base.provider, ...patch.provider };
  if (patch.safety) out.safety = { ...base.safety, ...patch.safety };
  if (patch.personas) out.personas = { ...base.personas, ...patch.personas };
  return out;
}

/** The whole /admin subtree. Returns null when the path is not ours. */
async function handleAdmin(req, env, path) {
  if (path === "/admin" || path === "/admin/") {
    if (await isAuthed(req, env)) {
      return new Response(renderDashboard(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(renderLogin(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (path === "/admin/api/login" && req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    const body = ct.includes("application/json")
      ? await req.json().catch(() => ({}))
      : Object.fromEntries(await req.formData());
    if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
      return new Response(renderLogin("Wrong password."), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const cookie = `${COOKIE}=${await signSecret(env.ADMIN_PASSWORD)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": cookie } });
  }

  if (path === "/admin/api/logout") {
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` } });
  }

  if (path === "/admin/api/clear-errors" && req.method === "POST") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const stats = await bumpStats(env, { resetErrors: true, clearErrors: true, lastError: null });
    return json({ ok: true, stats });
  }

  if (path === "/admin/api/log") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const items = await readArchive(env);
    return json({ count: items.length, items });
  }

  if (path === "/admin/api/quota") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const daily = await loadQuota(env);
    const combined = { ...daily };
    const now = Date.now();
    for (const [m, resetAt] of minuteQuota.entries()) {
      if (resetAt > now && (!combined[m] || combined[m] < resetAt)) {
        combined[m] = resetAt;
      }
    }
    return json({ quota: combined, now });
  }

  if (path === "/admin/api/clear-quota" && req.method === "POST") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    await saveQuota(env, {});
    clearMinuteQuota();
    return json({ ok: true });
  }

  if (path === "/admin/api/state") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const loaded = await loadConfig(env, DEFAULT_PERSONAS);
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const config = await saveConfig(env, deepMerge(loaded.config, readPatch(body)));
      return json({ ok: true, config, stats: loaded.stats });
    }
    return json({ config: loaded.config, stats: loaded.stats });
  }

  return null;
}

// ------------------------------ src/telegram.js ------------------------------
// Telegram Bot API client and the outbound half of a reply.



const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/** Call any Bot API method. Throws only on transport errors; Telegram errors come back as ok:false. */
async function tg(token, method, payload) {
  const res = await fetch(api(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return res.json();
}

const getMe = (token) => tg(token, "getMe");

let botIdCache = null;

/** The bot's own id, fetched once per isolate. Telegram asks for it on every answer. */
async function botId(env) {
  if (botIdCache) return botIdCache;
  const me = await getMe(env.TELEGRAM_BOT_TOKEN);
  if (!me?.ok) throw new Error(`getMe failed: ${me?.description ?? "unknown"}`);
  botIdCache = me.result.id;
  return botIdCache;
}

const setWebhook = (token, url, secretToken) =>
  tg(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: true,
    max_connections: 10,
  });

const deleteWebhook = (token) => tg(token, "deleteWebhook", { drop_pending_updates: false });
const getWebhookInfo = (token) => tg(token, "getWebhookInfo");
const sendChatAction = (token, chatId, action = "typing") => tg(token, "sendChatAction", { chat_id: chatId, action });

/** Send a message, trying HTML first and degrading to plain text if Telegram objects. */
async function sendText(token, chatId, text, replyTo) {
  const base = { chat_id: chatId };
  // reply_parameters, not reply_to_message_id: a deleted target never costs us the message.
  if (replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const first = await tg(token, "sendMessage", { ...base, text: mdToHtml(text), parse_mode: "HTML" });
  if (first?.ok) return first;

  const retry = await tg(token, "sendMessage", { ...base, text });
  if (!retry?.ok) throw new Error(`sendMessage failed: ${retry?.description ?? "unknown"}`);
  return retry;
}

/**
 * Send a long answer. The split is measured on the *rendered* HTML, because markdown grows
 * once it becomes tags — otherwise a bold-heavy answer silently blows past the 4096 limit.
 */
async function sendLong(token, chatId, text, replyTo) {
  for (const chunk of splitText(text, 3200)) {
    const rendered = mdToHtml(chunk).length;
    if (rendered <= 3900) {
      await sendText(token, chatId, chunk, replyTo);
      continue;
    }
    const narrower = Math.max(600, Math.floor((chunk.length * 3800) / rendered));
    for (const sub of splitText(chunk, narrower)) {
      await sendText(token, chatId, sub, replyTo);
    }
  }
}

/** Download a Telegram file. Returns raw bytes; the caller decides how to encode them. */
async function downloadFile(token, fileId) {
  const info = await tg(token, "getFile", { file_id: fileId });
  if (!info?.ok || !info.result?.file_path) throw new Error("getFile failed");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
  if (!res.ok) throw new Error("file download failed");
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Send an audio file so it plays in the chat. WAV is not a format every client likes for
 * `sendAudio`, so a refusal falls back to `sendDocument` — the user still gets the sound.
 */
async function sendAudioFile(token, chatId, bytes, fileName, mime, replyTo) {
  const blob = () => new Blob([bytes], { type: mime });

  const post = (method, field) => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (replyTo) form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    form.append(field, blob(), fileName);
    return fetch(api(token, method), { method: "POST", body: form })
      .then((r) => r.json())
      .catch(() => null);
  };

  const first = await post("sendAudio", "audio");
  if (first?.ok) return first;

  const second = await post("sendDocument", "document");
  if (second?.ok) return second;

  throw new Error(`sendAudio failed: ${first?.description ?? second?.description ?? "unknown"}`);
}

// ------------------------------ src/media.js ------------------------------
// Telegram media in, provider-neutral parts out.
//
// Everything here is base64 already, so neither provider module has to know about
// Telegram. Each media type has its own on/off switch, size cap and per-message limit.




/** Map a Telegram message (or a message it replied to) onto one media slot. */
function detectMedia(msg) {
  if (!msg) return null;
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { type: "image", id: p.file_id, mime: "image/jpeg", size: p.file_size ?? 0, label: "photo" };
  }
  if (msg.video) {
    return { type: "video", id: msg.video.file_id, mime: msg.video.mime_type || "video/mp4", size: msg.video.file_size ?? 0, label: "video" };
  }
  if (msg.video_note) {
    return { type: "video", id: msg.video_note.file_id, mime: "video/mp4", size: msg.video_note.file_size ?? 0, label: "video note" };
  }
  if (msg.animation) {
    return {
      type: "video",
      id: msg.animation.file_id,
      mime: msg.animation.mime_type || "video/mp4",
      size: msg.animation.file_size ?? 0,
      label: "animation/gif",
    };
  }
  if (msg.document && (msg.document.mime_type ?? "").startsWith("image/")) {
    return {
      type: "image",
      id: msg.document.file_id,
      mime: msg.document.mime_type,
      size: msg.document.file_size ?? 0,
      label: msg.document.file_name || "image file",
    };
  }
  if (msg.voice) {
    return { type: "audio", id: msg.voice.file_id, mime: msg.voice.mime_type || "audio/ogg", size: msg.voice.file_size ?? 0, label: "voice" };
  }
  if (msg.audio) {
    return { type: "audio", id: msg.audio.file_id, mime: msg.audio.mime_type || "audio/mpeg", size: msg.audio.file_size ?? 0, label: "audio" };
  }
  if (msg.sticker) return { type: "sticker", label: "sticker", size: 0 };
  if (msg.document) return { type: "file", id: msg.document.file_id, mime: msg.document.mime_type, size: msg.document.file_size ?? 0, label: msg.document.file_name || "document" };
  return null;
}

/**
 * Collect media from the replied-to message and from the message itself.
 * Anything switched off, oversized or unsupported becomes a readable note instead,
 * so the rest of the message is still answered.
 */
async function collectMedia(env, msg, cfg) {
  const parts = [];
  const notes = [];
  const used = { image: 0, video: 0, audio: 0 };

  const sources = [
    ["replied", detectMedia(msg.reply_to_message)],
    ["own", detectMedia(msg)],
  ];

  for (const [source, m] of sources) {
    if (!m) continue;

    if (m.type === "sticker") {
      notes.push(`${source} sticker`);
      continue;
    }
    if (m.type === "file") {
      notes.push(`${source} ${m.label} — documents are not supported`);
      continue;
    }

    const rules = cfg.media?.[m.type];
    if (!rules?.enabled) {
      notes.push(`${source} ${m.label} — ${m.type} input is turned off`);
      continue;
    }
    if (used[m.type] >= rules.maxPer) {
      notes.push(`${source} ${m.label} — more than ${rules.maxPer} ${m.type} per message`);
      continue;
    }
    if (m.size > rules.maxMB * 1024 * 1024) {
      notes.push(`${source} ${m.label}, ${(m.size / 1048576).toFixed(1)} MB — over the ${rules.maxMB} MB limit, only this note is sent`);
      continue;
    }

    try {
      const bytes = await downloadFile(env.TELEGRAM_BOT_TOKEN, m.id);
      parts.push({ type: m.type, mime: m.mime, data: toBase64(bytes) });
      used[m.type]++;
    } catch (e) {
      notes.push(`${source} ${m.label} could not be downloaded: ${e.message}`);
    }
  }

  return { media: parts, note: notes.length ? `[${notes.join(" | ")}]` : "" };
}

// ------------------------------ src/voice.js ------------------------------
// Voice replies through the Gemini Live API — one short-lived session per answer.
//
// answer.js produces the text; this module makes the bot *say* it: open a WebSocket to
// gemini-3.8-live, hand the text over as a single turn, collect raw PCM at 24 kHz and
// wrap it in a WAV header. WAV is deliberate: it is just 44 bytes over raw PCM, so the
// free plan's 10 ms CPU budget survives (an MP3 encoder would not).
//
// The session is one-shot — setup, one turn, close — because the webhook answers
// immediately and only gets one waitUntil window (30 s) to finish the job.

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_MODEL = "gemini-3.8-live";
const FALLBACK_VOICE_MODELS = [
  "gemini-3.8-live",
  "gemini-2.5-flash-native-audio-dialog",
  "gemini-2.0-flash-exp",
];
const WAV_RATE = 24000; // Live API audio output: PCM 16-bit little-endian, 24 kHz mono
const SPOKEN_MAX = 1500; // ~1.5 min of speech; longer answers would blow the 30 s window
const STALL_MS = 2500; // no new audio for this long ⇒ the turn is over (turnComplete can be very late)

/** The bot speaks as Sayyad; it must add nothing to the text it was handed. */
const SPEAK_PROMPT =
  "تو «سید» هستی. این متن، جواب خودت است؛ فقط و فقط همان را با صدای فارسی روان، گفتاری و صمیمی بخوان. " +
  "مثل آدم حرف بزن، نه مثل خواندن متن. چیزی اضافه یا کم نکن.";

let liveTimeoutMs = 25_000; // whole session, comfortably inside the 30 s waitUntil budget

/** Tests shrink this so a silent session fails fast instead of in 25 s. */
function setLiveTimeout(ms) {
  liveTimeoutMs = ms;
}

/**
 * Markdown → something a voice can say: no asterisks, no headings, no code fences,
 * links reduced to their label. Written for spoken output, not for rendering.
 */
function spokenText(text) {
  return String(text ?? "")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[>\-+*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SPOKEN_MAX);
}

/** Raw 16-bit LE mono PCM → WAV. The whole container is 44 bytes of header. */
function pcmToWav(pcm, rate = WAV_RATE) {
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const ascii = (s, off) => [...s].forEach((c, i) => (header[off + i] = c.charCodeAt(0)));
  ascii("RIFF", 0);
  v.setUint32(4, 36 + pcm.length, true);
  ascii("WAVE", 8);
  ascii("fmt ", 12);
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // format: PCM
  v.setUint16(22, 1, true); // channels: mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii("data", 36);
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(header, 0);
  out.set(pcm, 44);
  return out;
}

/** Frames arrive as string, ArrayBuffer or Blob depending on the runtime — accept all three. */
async function frameText(data) {
  if (typeof data === "string") return data;
  if (typeof data?.arrayBuffer === "function") data = await data.arrayBuffer();
  return new TextDecoder().decode(data);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** base64 → bytes without Buffer (the Worker runtime has no Buffer). */
function base64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
async function speakOnce(key, model, words, timeoutMs) {
  const res = await fetch(`${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("live voice: WebSocket upgrade was refused");

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let stallTimer = 0;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      try {
        ws.close(1000, "turn over");
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const hardTimer = setTimeout(
      () => finish(chunks.length ? null : new Error("live voice: timed out"), chunks.length ? pcmToWav(concat(chunks)) : undefined),
      timeoutMs,
    );

    /** The turn is over when the server says so, or when the audio goes quiet. */
    const audioReceived = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => finish(chunks.length ? null : new Error("live voice: no audio came back"), chunks.length ? pcmToWav(concat(chunks)) : undefined),
        STALL_MS,
      );
    };

    const send = (msg) => ws.send(JSON.stringify(msg));

    let queue = Promise.resolve();
    const enqueue = (ev) => {
      queue = queue.then(() => handle(ev)).catch(() => {});
    };

    async function handle(ev) {
      let msg;
      try {
        msg = JSON.parse(await frameText(ev.data));
      } catch {
        return; // keepalive or unknown frame — not worth failing the reply over
      }

      if (msg.error) {
        const detail = msg.error.message ?? msg.error.status ?? JSON.stringify(msg.error);
        return finish(new Error(`live voice: ${detail}`));
      }

      if (msg.setupComplete !== undefined) {
        send({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: words }] }],
            turnComplete: true,
          },
        });
        return;
      }

      for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          chunks.push(base64Bytes(part.inlineData.data));
          audioReceived();
        }
      }

      if (msg.serverContent?.turnComplete || msg.turnComplete) {
        finish(chunks.length ? null : new Error("live voice: turn completed without audio"), chunks.length ? pcmToWav(concat(chunks)) : undefined);
      }
    }

    ws.addEventListener("message", enqueue);
    ws.addEventListener("close", () => queue.then(() => finish(chunks.length ? null : new Error("live voice: connection closed before any audio"), chunks.length ? pcmToWav(concat(chunks)) : undefined)));
    ws.addEventListener("error", () => queue.then(() => finish(chunks.length ? null : new Error("live voice: connection error"), chunks.length ? pcmToWav(concat(chunks)) : undefined)));

    if (typeof ws.accept === "function") ws.accept(); // Workers' outbound sockets need this
    try {
      ws.binaryType = "arraybuffer"; // never deal with Blobs
    } catch {
      /* read-only in some runtimes */
    }

    send({
      setup: {
        model: `models/${model}`,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: { parts: [{ text: SPEAK_PROMPT }] },
      },
    });
  });
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
async function speak(env, cfg, text, opts = {}) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("live voice: GEMINI_API_KEY is not set");

  const words = spokenText(text);
  if (!words) throw new Error("live voice: nothing to say");

  const timeoutMs = opts.timeoutMs ?? liveTimeoutMs;
  const startAt = Date.now();
  const primary = cfg?.voice?.model || DEFAULT_MODEL;
  const pool = [primary, ...FALLBACK_VOICE_MODELS.filter((m) => m !== primary)];

  let lastErr;
  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    const elapsed = Date.now() - startAt;
    const remaining = timeoutMs - elapsed;
    if (i > 0 && remaining < 2000) break;

    try {
      return await speakOnce(key, model, words, Math.max(1, remaining));
    } catch (e) {
      lastErr = e;
      if (!/model|not found|unknown|404|unsupported|unavailable/i.test(e.message)) {
        throw e;
      }
    }
  }

  throw lastErr ?? new Error("live voice: all voice models failed");
}

// ------------------------------ src/answer.js ------------------------------
// The answering pipeline: webhook update in, Telegram reply out.









const ERRORS = [
  "الان یه کم درگیرم. یه بار دیگه بفرست، شاید سر جا شد.",
  "یه چیزی قاطی شد. دوباره بزن، درستش می‌کنم.",
  "حواسم پرته. یه بار دیگه امتحان کن.",
];

/** 429 means slow down, whoever the provider is. */
const RATE_LIMITED = "سقف درخواست پر شد. چند دقیقه صبر کن و دوباره بفرست.";
const DAILY_LIMIT = "امروز از سقف روزانه‌ام رد شدیم. فردا دوباره در خدمتم.";

// Speaking runs late in the waitUntil window, so cap it well below the 30 s budget:
// the WAV upload afterwards needs a few seconds of its own.
const VOICE_BUDGET_MS = 26_000;

const MODE_NAME = { rude: "Savage", polite: "Polite", smart: "Know-it-all" };

const HELP =
  "سلام، من **سید** هستم.\n\n" +
  "• توی گروه کافیه کلمه **سید** رو توی پیامت بنویسی.\n" +
  "• یا روی هر پیامی ریپلای کنی و بنویسی «سید این چی میگه؟» تا همون پیام رو برات بخونم.\n" +
  "• عکس، ویدیو و ویس هم می‌فهمم، اگر خیلی سنگین نباشه.\n" +
  "• به **ویس نوت**‌ها جواب **صوتی** می‌دهم.\n\n" +
  "I'm __MODE__ mode right now.";

const jobs = new Map();
const capNotified = new Map();

/**
 * "ساعت ۹:۳۰" — the exact moment the daily quota frees up, in Tehran time. Google resets
 * RPD at midnight Pacific: 09:30 Tehran in summer, 08:30 in winter.
 */
function clockTime(resetAt) {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(resetAt));
  } catch {
    return new Date(resetAt).toISOString().slice(11, 16);
  }
}

const exhaustedNotice = (resetAt) =>
  resetAt - Date.now() < 300_000
    ? "در حال حاضر ترافیک و درخواست‌ها به مدل‌های هوش مصنوعی بالاست. لطفاً ۱ دقیقه دیگر دوباره پیام دهید."
    : `امروز از سقف روزانه‌ی همه‌ی مدل‌هام رد شدیم. ساعت ${clockTime(resetAt)} دوباره در خدمتم.`;

/** One answer at a time per chat; anything else queues behind it. */
function serialize(key, job) {
  const prev = jobs.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  const tail = next.catch(() => {});
  jobs.set(key, tail);
  tail.then(() => {
    if (jobs.get(key) === tail) jobs.delete(key);
  });
  return next;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * The one entry point the router calls. Archives every message first — including the ones
 * Sayyad ignores — then answers only what deserves an answer.
 */
async function processMessage(env, msg) {
  if (!msg?.from || msg.from.is_bot) return; // never answer bots
  if (!isSupportedChat(msg)) return;

  const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;

  let answered = false;
  try {
    answered = cfg.enabled && shouldAnswer(msg, await botId(env), msg.chat.type);
  } catch {
    /* getMe failed: archive it as unanswered rather than losing the record */
  }
  if (!config_enabled(cfg) || !answered) {
    await appendArchive(env, archiveRecord(msg, false));
    return;
  }

  await serialize(msg.chat.id, async () => {
    let outcome = null;
    let replyError = null;
    try {
      outcome = await reply(env, msg, cfg);
    } catch (e) {
      replyError = e;
      const reason = String(e?.message ?? e);
      await bumpStats(env, { errors: 1, lastError: reason.slice(0, 300) });
      // The pool carries the exact hour its quota frees up — far more useful than "later".
      const text =
        e instanceof PoolExhausted
          ? exhaustedNotice(e.resetAt)
          : /\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(reason)
            ? RATE_LIMITED
            : ERRORS[Math.abs(hash(`${msg.chat.id}:${msg.message_id}`)) % ERRORS.length];
      try {
        await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, text, msg.message_id);
      } catch {
        /* nothing more we can do */
      }
    } finally {
      await appendArchive(
        env,
        archiveRecord(msg, {
          answered: true,
          ok: !replyError,
          model: outcome?.model,
          reply: outcome?.text,
          error: replyError ? String(replyError.message ?? replyError) : null,
        }),
      );
    }
  });
}

const config_enabled = (cfg) => cfg.enabled !== false;

async function reply(env, msg, cfg) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const cmd = isCommand(text);

  if (cmd === "ping") {
    await sendText(token, chatId, "🏓 pong", msg.message_id);
    return { text: "🏓 pong" };
  }
  if (cmd === "start" || cmd === "help") {
    const helpMsg = HELP.replace("__MODE__", MODE_NAME[cfg.mode] ?? "Know-it-all");
    await sendText(token, chatId, helpMsg, msg.message_id);
    return { text: helpMsg };
  }

  // Checked before the typing indicator and before any model call, so an exhausted day
  // costs no quota and does not look like a hang.
  if (await overDailyCap(env, cfg, msg)) return { text: DAILY_LIMIT };

  await sendChatAction(token, chatId, "typing");
  await bumpStats(env, { requests: 1, lastUsed: new Date().toISOString() });

  const id = await botId(env);
  const { media, note } = await collectMedia(env, msg, cfg);
  const { text: replyText, fromBot } = replyContext(msg, id);

  const { text: answer, model: usedModel } = await complete(env, cfg, {
    system: buildSystemPrompt(cfg),
    parts: buildUserContent({ text, replyText, replyFromBot: fromBot, media, note }),
    maxTokens: cfg.maxTokens,
  });

  // A voice note deserves a voice back: the text answer above becomes a Live API turn
  // and comes back as audio. Anything that goes wrong here is caught by processMessage
  // and reported with one of the friendly ERRORS — never with a silent gap.
  if (voiceReply(msg, cfg)) {
    const startAt = Date.now();
    const elapsed = () => Date.now() - startAt;
    const keep = setInterval(() => sendChatAction(token, chatId, "upload_voice").catch(() => {}), 4000);
    let audioSent = false;
    try {
      if (elapsed() > VOICE_BUDGET_MS) throw new Error("live voice: over the time budget");
      const wav = await speak(env, cfg, answer, { timeoutMs: Math.max(3000, VOICE_BUDGET_MS - elapsed()) });
      await sendAudioFile(token, chatId, wav, "sayyad.wav", "audio/wav", msg.message_id);
      audioSent = true;
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel, voice: true };
    } catch (voiceErr) {
      await bumpStats(env, { errors: 1, lastError: `voice failed: ${voiceErr?.message ?? voiceErr}`.slice(0, 300) });
    } finally {
      clearInterval(keep);
    }
    if (!audioSent) {
      await sendLong(token, chatId, answer, msg.message_id);
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel };
    }
  }

  await sendLong(token, chatId, answer, msg.message_id);
  await bumpStats(env, { replies: 1 });
  return { text: answer, model: usedModel };
}

/** Voice notes are answered with voice — unless either switch (input or voice) is off. */
const voiceReply = (msg, cfg) =>
  !!msg.voice && cfg.media?.audio?.enabled !== false && cfg.voice?.enabled !== false;

/** Refuse politely once the daily budget is gone, and never call the model. */
async function overDailyCap(env, cfg, msg) {
  if (!(cfg.dailyCap > 0)) return false;
  if (usedToday(await loadStats(env)) < cfg.dailyCap) return false;

  const last = capNotified.get(msg.chat.id) ?? 0;
  if (Date.now() - last < 3_600_000) return true;
  capNotified.set(msg.chat.id, Date.now());
  try {
    await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, DAILY_LIMIT, msg.message_id);
  } catch {
    /* the guard still works even if the notice does not get through */
  }
  return true;
}

// ------------------------------ src/tools.js ------------------------------
// Operator routes: /diag (is anything broken?) and /setup (point Telegram here).







/** A live probe of both the Telegram side and the configured model. */
async function diagnostics(env) {
  const out = { provider: null, model: null, checks: {} };

  if (!env.TELEGRAM_BOT_TOKEN) {
    out.checks.telegram = "TELEGRAM_BOT_TOKEN secret is missing";
  } else {
    const me = await getMe(env.TELEGRAM_BOT_TOKEN);
    out.checks.telegram = { ok: !!me?.ok, username: me?.result?.username, error: me?.description };
    const wh = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN);
    out.checks.webhook = {
      url: wh?.result?.url,
      pending: wh?.result?.pending_update_count,
      lastError: wh?.result?.last_error_message,
    };
  }

  const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;
  out.provider = cfg.provider.kind;
  out.model = cfg.provider.model;
  out.endpoint =
    cfg.provider.kind === "gemini"
      ? `${cfg.provider.baseUrl}/models/${cfg.provider.model}:generateContent`
      : `${cfg.provider.baseUrl}/chat/completions`;

  out.checks.credentials = {
    gemini: env.GEMINI_API_KEY ? "set" : "missing",
    openai: env.API_KEY || env.OPENROUTER_API_KEY ? "set" : "missing",
  };

  try {
    const diagCfg = { ...cfg, thinking: "off" };
    const r = await complete(env, diagCfg, {
      system: "You are Sayyad. Answer with one short Persian word.",
      parts: [{ type: "text", text: "say: تست" }],
      maxTokens: 120,
    });
    out.checks.text = { ok: true, sample: r.text.slice(0, 120), usage: r.usage, model: r.model };
    out.checks.model = out.checks.text;
  } catch (e) {
    out.checks.text = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    out.checks.model = out.checks.text;
  }

  if (env.DIAG_IMAGE) {
    try {
      const diagCfg = { ...cfg, thinking: "off" };
      const rImg = await complete(env, diagCfg, {
        system: "You are Sayyad. Answer with one short Persian word.",
        parts: [
          { type: "image", mime: "image/png", data: env.DIAG_IMAGE },
          { type: "text", text: "تست تصویر" },
        ],
        maxTokens: 120,
      });
      out.checks.image = { ok: true, sample: rImg.text.slice(0, 120), usage: rImg.usage, model: rImg.model };
    } catch (e) {
      out.checks.image = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }
  }

  out.note = "Video and audio are only sent through the Gemini native provider.";
  return out;
}

/** Point Telegram's webhook at this Worker. */
async function setup(req, env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) return { error: "TELEGRAM_BOT_TOKEN is not set" };

  const plain = url.searchParams.get("plain") === "1" || !env.ADMIN_PASSWORD;
  const secretToken = plain ? undefined : await signWebhookSecret(env.ADMIN_PASSWORD);
  const target = url.searchParams.get("url") ?? url.origin;

  const set = await setWebhook(env.TELEGRAM_BOT_TOKEN, target, secretToken);
  const info = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN);
  return { target, secret_token_used: !!secretToken, setWebhook: set, getWebhookInfo: info };
}

async function resetWebhook(env) {
  return deleteWebhook(env.TELEGRAM_BOT_TOKEN);
}

async function signWebhookSecret(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sayyad-webhook-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Wrap a report in a minimal readable page. */
function reportPage(title, data) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="background:#0e1117;color:#e6edf3;font:14px ui-monospace,monospace;padding:24px">
<h3>${esc(title)}</h3><pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
}

// ------------------------------ src/index.js ------------------------------
// Entrypoint. Routing only — every decision lives in another module.





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
      const handled = await handleAdmin(req, env, path).catch((e) => {
        return json({ error: String(e?.message ?? e) }, 500);
      });
      if (handled) return handled;
    }

    return json({ error: "not found" }, 404);
  },
};

async function webhook(req, env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("TELEGRAM_BOT_TOKEN is not set", { status: 500 });

  // Only Telegram, verified by the secret we handed out at /setup.
  if (env.ADMIN_PASSWORD) {
    const want = await signWebhookSecret(env.ADMIN_PASSWORD);
    if ((req.headers.get("x-telegram-bot-api-secret-token") ?? "") !== want) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const update = await req.json().catch(() => null);
  if (update && typeof update.update_id === "number") {
    if (seen.has(update.update_id)) return new Response("ok"); // Telegram retried a delivery
    seen.add(update.update_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  if (update?.message) ctx.waitUntil(processMessage(env, update.message));
  return new Response("ok");
}

export { ARCHIVE_KEY, ARCHIVE_LIMIT, ApiError, BASE_RULES, CONFIG_KEY, COOKIE, DEFAULT_BACKOFF, DEFAULT_BASE_URLS, DEFAULT_MODEL, DEFAULT_MODEL_POOL, DEFAULT_PERSONAS, DailyQuotaError, FALLBACK_VOICE_MODELS, LEGACY_CONFIG_KEY, LEGACY_STATS_KEY, MODES, MODE_LABELS, MinuteQuotaError, PACIFIC_OFFSET_MS, PoolExhausted, QUOTA_KEY, REPLY_TEXT_LIMIT, SAFETY_CATEGORIES, SAFETY_CATEGORY_KEYS, SAFETY_LEVELS, SCHEMA_VERSION, STATS_KEY, THINKING_LEVELS, TRIGGER, UnknownModelError, appendArchive, archiveRecord, botId, buildGeminiBody, buildSystemPrompt, buildUserContent, bumpStats, callJson, clampInt, clearMinuteQuota, collectMedia, complete, completeGemini, completeOpenAI, defaultConfig, deleteWebhook, detectMedia, diagnostics, downloadFile, endpointOf, esc, getMe, getWebhookInfo, handleAdmin, isAuthed, isCommand, isCredentialError, isShapeError, isSupportedChat, isTransient, json, loadConfig, loadQuota, loadStats, mdToHtml, mediaKind, migrateLegacy, minuteQuota, nextPacificMidnight, normalizeConfig, normalizeFa, normalizePool, pcmToWav, poolResumeTime, preview, processMessage, providerFor, quotaKind, readArchive, readGeminiText, readPatch, renderDashboard, renderLogin, replyContext, reportPage, resetWebhook, safetySettings, saveConfig, saveQuota, sendAudioFile, sendChatAction, sendLong, sendText, setLiveTimeout, setWebhook, setup, shouldAnswer, signSecret, signWebhookSecret, speak, splitText, spokenText, tg, thinkingConfig, toBase64, toGeminiPart, toOpenAIPart, todayKey, truncate, usedToday };
