// ============================================================================
//  Sayyad — Telegram bot on Cloudflare Workers
//  GENERATED FILE. Do not edit by hand: edit ./src and run "node build.mjs".
//  Module order, resolved from the import graph: archive.js, http.js, store.js, keyPool.js, providerGemini.js, providerOpenai.js, llm.js, text.js, trigger.js, prompt.js, admin.js, telegram.js, media.js, nodeWs.js, voice.js, answer.js, tools.js, index.js, nodeStore.js
// ============================================================================
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";


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
    if (outcome.reason) r.reason = String(outcome.reason).slice(0, 300);
    if (outcome.ms !== undefined) r.ms = outcome.ms;
    if (outcome.voice !== undefined) r.voice = outcome.voice;
    if (outcome.voiceError) r.verr = String(outcome.voiceError).slice(0, 500);
    if (outcome.tgOut) r.tgOut = String(outcome.tgOut).slice(0, 300);
    if (outcome.trace) r.trace = outcome.trace;
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
    if (!env?.CONFIG) return [];
    const raw = await env.CONFIG.get(ARCHIVE_KEY, "json");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Prepend a record and drop the oldest past the limit. Never throws. */
async function appendArchive(env, record) {
  try {
    if (!env?.CONFIG) return;
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
const TRANSIENT = new Set([0, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

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
async function callJson(url, { headers, body, retries = 2, backoff = DEFAULT_BACKOFF, retryOn = isTransient, timeoutMs = 15_000 }) {
  const attempts = Math.max(0, retries) + 1;
  let last;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]);

    let error;
    try {
      const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
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
const MULTIMODAL_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
];

const TEXT_EXTENDED_MODELS = [
  "Antigravity",
  "gemma-4-26b",
  "gemma-4-31b",
];

const DEFAULT_MODEL_POOL = [
  ...MULTIMODAL_MODELS,
  ...TEXT_EXTENDED_MODELS,
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
      model: "gemini-3.5-flash-lite",
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

// ------------------------------ src/keyPool.js ------------------------------
// Multi-key pool manager for Google Gemini API keys.
// Provides Round-Robin load balancing, per-key concurrency locking (one in-flight request per key),
// RPM/RPD cooldown tracking, dead key isolation, and JSON file persistence.





let roundRobinIndex = 0;
let keyPoolCache = null;
let stateFilePath = null;

function getStatePath() {
  return stateFilePath;
}

function setStateFilePath(path) {
  stateFilePath = path;
}

function cleanKey(item) {
  if (!item || typeof item !== "string") return "";
  return item.replace(/^[\s\{\}\[\]"'`]+|[\s\{\}\[\]"'`]+$/g, "").trim();
}

/** Extract list of raw keys from environment or config. */
function extractKeys(env) {
  let raw = undefined;
  if (env && ("GEMINI_API_KEYS" in env || "GEMINI_API_KEY" in env)) {
    raw = env.GEMINI_API_KEYS || env.GEMINI_API_KEY;
  } else if (typeof process !== "undefined") {
    raw = process.env?.GEMINI_API_KEYS || process.env?.GEMINI_API_KEY;
  }

  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map(cleanKey).filter((k) => k.length >= 1 && !k.startsWith("#"));
  }

  const str = String(raw).trim();

  // Try parsing JSON array or object if strictly valid JSON
  if ((str.startsWith("[") && str.endsWith("]")) || (str.startsWith("{") && str.endsWith("}"))) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map(cleanKey).filter((k) => k.length >= 1 && !k.startsWith("#"));
      }
      if (parsed && typeof parsed === "object") {
        return Object.values(parsed).map(cleanKey).filter((k) => k.length >= 1 && !k.startsWith("#"));
      }
    } catch {
      // If not strict JSON (e.g. unquoted {apikey1, apikey2}), fall through to delimiter splitting
    }
  }

  return str
    .split(/[\r\n,;]+/)
    .map(cleanKey)
    .filter((k) => k.length >= 1 && !k.startsWith("#"));
}

/** Load or initialize the persistent state of all keys. */
function loadState(keys) {
  let saved = {};
  const filePath = getStatePath();
  try {
    if (filePath && typeof existsSync === "function" && existsSync(filePath)) {
      if (typeof readFileSync === "function") {
        saved = JSON.parse(readFileSync(filePath, "utf-8")) || {};
      }
    }
  } catch {
    /* fallback to clean memory state if file read fails */
  }

  const now = Date.now();
  return keys.map((key, idx) => {
    const s = saved[key] || {};
    return {
      key,
      id: idx + 1,
      inUse: false, // In-flight lock resets on restart
      lastUsed: s.lastUsed || 0,
      requestsToday: s.requestsToday || 0,
      lastResetDay: s.lastResetDay || new Date().toISOString().slice(0, 10),
      rpmCooldownUntil: s.rpmCooldownUntil && s.rpmCooldownUntil > now ? s.rpmCooldownUntil : 0,
      rpdCooldownUntil: s.rpdCooldownUntil && s.rpdCooldownUntil > now ? s.rpdCooldownUntil : 0,
      modelRpdCooldown: s.modelRpdCooldown && typeof s.modelRpdCooldown === "object" ? s.modelRpdCooldown : {},
      modelRpmCooldown: s.modelRpmCooldown && typeof s.modelRpmCooldown === "object" ? s.modelRpmCooldown : {},
      highDemandCooldownUntil: s.highDemandCooldownUntil && s.highDemandCooldownUntil > now ? s.highDemandCooldownUntil : 0,
      disabled: Boolean(s.disabled),
      lastError: s.lastError || null,
    };
  });
}

/** Persist state to local JSON file safely. */
function saveState(pool) {
  const filePath = getStatePath();
  if (!filePath) return;
  try {
    if (typeof dirname !== "function" || typeof existsSync !== "function" || typeof writeFileSync !== "function") return;
    const dir = dirname(filePath);
    if (!existsSync(dir) && typeof mkdirSync === "function") mkdirSync(dir, { recursive: true });

    const obj = {};
    for (const item of pool) {
      obj[item.key] = {
        lastUsed: item.lastUsed,
        requestsToday: item.requestsToday,
        lastResetDay: item.lastResetDay,
        rpmCooldownUntil: item.rpmCooldownUntil,
        rpdCooldownUntil: item.rpdCooldownUntil,
        modelRpdCooldown: item.modelRpdCooldown || {},
        modelRpmCooldown: item.modelRpmCooldown || {},
        highDemandCooldownUntil: item.highDemandCooldownUntil,
        disabled: item.disabled,
        lastError: item.lastError,
      };
    }
    writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
  } catch {
    /* file persistence is non-blocking and safe */
  }
}

/** Get or initialize the active key pool. */
function getKeyPool(env) {
  const keys = extractKeys(env);
  if (!keys.length) return [];

  if (
    !keyPoolCache ||
    keyPoolCache.length !== keys.length ||
    !keys.every((k, i) => keyPoolCache[i]?.key === k)
  ) {
    keyPoolCache = loadState(keys);
  }
  return keyPoolCache;
}

/** Reset in-memory key pool cache (useful for tests or hot-reload). */
function clearKeyPoolCache() {
  keyPoolCache = null;
  roundRobinIndex = 0;
}

/**
 * Acquire the next available key using Round-Robin, enforcing concurrency lock (inUse)
 * and skipping cooling/disabled keys.
 */
function acquireKey(env, opts = {}) {
  const pool = getKeyPool(env);
  if (!pool.length) return null;

  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);

  // Check rollover for today counters
  for (const item of pool) {
    if (item.lastResetDay !== todayStr) {
      item.requestsToday = 0;
      item.lastResetDay = todayStr;
      if (item.rpdCooldownUntil && item.rpdCooldownUntil <= now) {
        item.rpdCooldownUntil = 0;
      }
      if (item.modelRpdCooldown) {
        for (const [m, t] of Object.entries(item.modelRpdCooldown)) {
          if (t <= now) delete item.modelRpdCooldown[m];
        }
      }
      if (item.modelRpmCooldown) {
        for (const [m, t] of Object.entries(item.modelRpmCooldown)) {
          if (t <= now) delete item.modelRpmCooldown[m];
        }
      }
    }
  }

  const count = pool.length;
  for (let step = 0; step < count; step++) {
    const idx = (roundRobinIndex + step) % count;
    const item = pool[idx];

    if (item.disabled) continue;
    if (item.inUse) continue; // One concurrent request per key rule
    if (item.rpmCooldownUntil > now) continue;
    if (opts?.model && item.modelRpmCooldown?.[opts.model] > now) continue;
    if (item.rpdCooldownUntil > now) continue;
    if (opts?.model && item.modelRpdCooldown?.[opts.model] > now) continue;
    if (item.highDemandCooldownUntil > now) continue;

    // Found available key! Lock it and advance round-robin index
    item.inUse = true;
    item.lastUsed = now;
    item.requestsToday++;
    roundRobinIndex = (idx + 1) % count;

    let released = false;
    const release = (err) => {
      if (released) return;
      released = true;
      item.inUse = false;
      if (err) recordKeyError(item, err, opts?.model);
      saveState(pool);
    };

    return {
      key: item.key,
      id: item.id,
      index: idx,
      release,
    };
  }

  return null; // All keys are currently busy or in cooldown
}

/**
 * Acquire next available key, waiting up to maxWaitMs (default 1500ms) if all keys are busy or cooling down.
 */
async function acquireKeyWithWait(env, opts = {}) {
  const maxWaitMs = typeof opts?.maxWaitMs === "number" ? opts.maxWaitMs : 1500;
  const pollIntervalMs = typeof opts?.pollIntervalMs === "number" ? opts.pollIntervalMs : 1500;
  const start = Date.now();

  while (true) {
    const handle = acquireKey(env, opts);
    if (handle) return handle;

    const pool = getKeyPool(env);
    if (!pool.length) return null;

    const usableKeys = pool.filter((k) => !k.disabled);
    if (!usableKeys.length) return null;

    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= maxWaitMs) return null;

    // Find earliest time when any usable key might be available
    let earliestAvailable = Infinity;
    for (const item of usableKeys) {
      if (item.inUse) {
        earliestAvailable = Math.min(earliestAvailable, now + Math.min(pollIntervalMs, 100));
      } else {
        const modelRpd = opts?.model ? (item.modelRpdCooldown?.[opts.model] || 0) : 0;
        const modelRpm = opts?.model ? (item.modelRpmCooldown?.[opts.model] || 0) : 0;
        const itemCooldown = Math.max(
          item.rpmCooldownUntil || 0,
          item.highDemandCooldownUntil || 0,
          modelRpd,
          modelRpm,
          item.rpdCooldownUntil || 0,
        );
        if (itemCooldown <= now) {
          earliestAvailable = now;
        } else {
          earliestAvailable = Math.min(earliestAvailable, itemCooldown);
        }
      }
    }

    if (earliestAvailable > now + (maxWaitMs - elapsed)) {
      return null;
    }

    const waitMs = Math.min(pollIntervalMs, Math.max(100, earliestAvailable - now), maxWaitMs - elapsed);
    if (waitMs <= 0) return null;

    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Classify error and apply proper cooldown or quarantine. */
function recordKeyError(item, err, reqModel) {
  const now = Date.now();
  const rawMsg = String(err?.message ?? err);
  let msg = rawMsg.replace(/key=[^&\s]+/gi, "key=[REDACTED]");
  if (item?.key) {
    msg = msg.split(item.key).join("[REDACTED]");
  }
  const status = Number(err?.status ?? 0);
  item.lastError = msg.slice(0, 300);

  // 1. Invalid or revoked API key -> permanently quarantine immediately
  if (
    (status === 400 || status === 403 || !status) &&
    (/API_KEY_INVALID|key.*invalid|unregistered callers|API key not valid|forbidden|not authorized|permission/i.test(msg))
  ) {
    item.disabled = true;
    return;
  }

  // 2. Safety filter block -> Key is healthy! Do NOT penalize key
  if (/blocked.*safety|prompt_blocked|finishReason.*safety/i.test(msg)) {
    return;
  }

  // 3. Daily quota exhaustion -> reset at Pacific midnight
  if (
    (status === 429 || status === 503) &&
    (/(?:^|[^a-z])(day|daily|rpd|24\s*h|requests_per_day)(?:[^a-z]|$)/i.test(msg) || /per.?day/i.test(msg) || err?.name === "DailyQuotaError")
  ) {
    const resetAt = err?.resetAt || nextPacificMidnight(now);
    const model = err?.model || reqModel;
    if (model) {
      if (!item.modelRpdCooldown) item.modelRpdCooldown = {};
      item.modelRpdCooldown[model] = resetAt;
    } else {
      item.rpdCooldownUntil = resetAt;
    }
    return;
  }

  // 4. Minute RPM rate limit -> 60 seconds cooldown (do not disable)
  if (
    status === 429 ||
    err?.name === "MinuteQuotaError" ||
    /resource_exhausted|quota exceeded|too many requests|rate.?limit/i.test(msg)
  ) {
    const model = err?.model || reqModel;
    if (model) {
      if (!item.modelRpmCooldown) item.modelRpmCooldown = {};
      item.modelRpmCooldown[model] = now + 60_000;
    } else {
      item.rpmCooldownUntil = now + 60_000;
    }
    return;
  }

  // 5. Server high demand / overload -> 30 seconds cooldown
  if (status === 503 || /high demand|spikes in demand|overloaded/i.test(msg)) {
    item.highDemandCooldownUntil = now + 30_000;
  }
}

/** Diagnostic overview of all keys in pool for admin dashboard. */
function getKeyPoolStatus(env) {
  const pool = getKeyPool(env);
  const now = Date.now();

  return pool.map((item) => {
    let status = "active";
    let detail = "Ready";

    if (item.disabled) {
      status = "invalid";
      detail = "Disabled / Invalid";
    } else if (item.rpdCooldownUntil > now || Object.values(item.modelRpdCooldown || {}).some((t) => t > now)) {
      status = "daily_quota";
      const maxCooldown = Math.max(item.rpdCooldownUntil || 0, ...Object.values(item.modelRpdCooldown || {}));
      const hoursLeft = Math.ceil((maxCooldown - now) / 3600_000);
      detail = `Daily quota reached (~${hoursLeft}h left)`;
    } else if (item.rpmCooldownUntil > now || Object.values(item.modelRpmCooldown || {}).some((t) => t > now)) {
      status = "rpm_cooldown";
      const maxRpm = Math.max(item.rpmCooldownUntil || 0, ...Object.values(item.modelRpmCooldown || {}));
      const secsLeft = Math.ceil((maxRpm - now) / 1000);
      detail = `Minute limit cooldown (${secsLeft}s left)`;
    } else if (item.highDemandCooldownUntil > now) {
      status = "busy_cooldown";
      const secsLeft = Math.ceil((item.highDemandCooldownUntil - now) / 1000);
      detail = `High demand cooldown (${secsLeft}s left)`;
    } else if (item.inUse) {
      status = "in_use";
      detail = "Processing request";
    }

    return {
      id: item.id,
      key: item.key, // Unmasked as requested in poll A10
      status,
      detail,
      requestsToday: item.requestsToday,
      lastError: item.lastError,
      lastUsed: item.lastUsed ? new Date(item.lastUsed).toISOString() : null,
    };
  });
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

const THINKING_BUDGETS = {
  off: 0,
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
};

/**
 * thinkingConfig. Google Gemini REST API expects thinkingConfig.thinkingBudget (integer token count:
 * minimal: 1024, low: 2048, medium: 4096, high: 8192, off: 0).
 */
function thinkingConfig(cfg) {
  if (!cfg?.thinking) return {};
  const budget = THINKING_BUDGETS[cfg.thinking] !== undefined ? THINKING_BUDGETS[cfg.thinking] : 4096;
  return { thinkingConfig: { thinkingBudget: budget } };
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
const HIGH_DEMAND_RE = /quota|resource_exhausted|high demand|spikes in demand|overloaded|temporarily unavailable/i;
const NO_RETRY_RE = /quota|resource_exhausted|high demand|spikes in demand|overloaded|temporarily unavailable|malformed_response|returned no text|empty answer/i;

const retryableForGemini = (e) =>
  isTransient(e) &&
  quotaKind(e.message) !== "day" &&
  quotaKind(e.message) !== "minute" &&
  !NO_RETRY_RE.test(e.message);

/**
 * Models differ in which knobs they accept — Gemma rejects thinkingConfig, some tiers
 * refuse a custom safety level. Drop the optional blocks one at a time rather than
 * letting the admin discover it as a broken bot.
 */
function shapes(cfg) {
  const list = [{}];
  if (cfg?.thinking) list.push({ noThinking: true });
  list.push({ noThinking: true, noSafety: true });
  return list;
}

async function completeGemini(env, cfg, { system, parts, maxTokens }) {
  const apiKey = cfg?.apiKey || env.GEMINI_API_KEY;
  if (!apiKey) throw new ApiError("GEMINI_API_KEY secret is not set", 500);

  const model = cfg.provider.model;
  const url = `${cfg.provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  let last = new ApiError("model returned an empty answer");

  const shapeList = shapes(cfg);
  for (const shape of shapeList) {
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
        (quotaKind(e.message) !== "other" || HIGH_DEMAND_RE.test(e.message));
      if (isQuota) {
        if (quotaKind(e.message) === "day") {
          throw new DailyQuotaError(model, `${model}: ${e.message}`);
        }
        throw new MinuteQuotaError(model, `${model}: ${e.message}`);
      }
      // A rejected knob is worth retrying with fewer of them; anything else must surface.
      if (!isShapeError(e) || /malformed_response/i.test(e.message) || shape === shapeList.at(-1)) throw e;
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
  if (part.type === "video") return { type: "text", text: "[Video attached: not supported by this provider]" };
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
const PROVIDERS = { gemini: completeGemini, openai: completeOpenAI };

/** In-memory parking for per-minute rate limits (RPM/TPM). Costs 0 KV writes. */
const minuteQuota = new Map();

function clearMinuteQuota() {
  minuteQuota.clear();
  clearKeyPoolCache();
}

function providerFor(cfg) {
  const impl = PROVIDERS[cfg.provider?.kind];
  if (!impl) throw new ApiError(`unknown provider "${cfg.provider?.kind}"`, 500);
  return impl;
}

/** Check if payload contains visual or audio media. */
function hasMediaPayload(payload) {
  return Array.isArray(payload?.parts) && payload.parts.some((p) => p && (p.type === "image" || p.type === "video" || p.type === "audio"));
}

/** Check if model name supports multimodal input. */
function isMultimodalModel(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("gemma") || m === "antigravity") return false;
  return m.startsWith("gemini") || (Array.isArray(MULTIMODAL_MODELS) && MULTIMODAL_MODELS.includes(model));
}

/** Map model names when falling back across providers. */
function mapModelForProvider(model, targetKind, baseUrl = "") {
  if (!model) return targetKind === "gemini" ? "gemini-3.5-flash-lite" : "gpt-4o-mini";
  const m = String(model).trim();

  if (targetKind === "gemini") {
    if (m.startsWith("gemini-") || m === "Antigravity" || m.startsWith("gemma-")) {
      return m;
    }
    return "gemini-3.5-flash-lite";
  }

  if (targetKind === "openai") {
    if (!m.startsWith("gemini-") && m !== "Antigravity" && !m.startsWith("gemma-")) {
      return m;
    }
    const isOpenRouter = String(baseUrl).includes("openrouter.ai");
    if (isOpenRouter) {
      if (m.startsWith("gemini-")) return "google/gemini-2.5-flash";
      if (m.startsWith("gemma-")) return "google/gemma-2-27b-it";
      return "openai/gpt-4o-mini";
    }
    return "gpt-4o-mini";
  }

  return m;
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
  const keys = extractKeys(env);
  if (!keys.length && !env.GEMINI_API_KEY) {
    throw new ApiError("GEMINI_API_KEY secret is not set", 500);
  }

  const rawPool = Array.isArray(cfg.provider.modelPool) && cfg.provider.modelPool.length
    ? cfg.provider.modelPool
    : [cfg.provider.model];

  // Modality-aware routing: filter to multimodal models if media is present
  const hasMedia = hasMediaPayload(payload);
  const pool = hasMedia ? rawPool.filter(isMultimodalModel) : rawPool;

  const quota = await loadQuota(env);
  const now = Date.now();
  const dirty = new Set();
  const trace = [];
  let last;

  for (const model of pool) {
    const modelNow = Date.now();
    if ((quota[model] ?? 0) > modelNow) {
      trace.push({ model, status: "skipped_quota_parked", error: "model parked until quota reset" });
      continue;
    }
    if ((minuteQuota.get(model) ?? 0) > modelNow) {
      trace.push({ model, status: "skipped_minute_parked", error: "model temporarily paused" });
      continue;
    }

    const poolKeys = getKeyPool(env);
    const usableKeys = poolKeys.filter((k) => !k.disabled);
    const totalUsableKeys = Math.max(1, usableKeys.length);

    let modelDailyFailures = 0;
    let modelMinuteFailures = 0;
    let lastModelQuotaError = null;
    let attemptsOnModel = 0;

    while (attemptsOnModel < totalUsableKeys) {
      attemptsOnModel++;
      const waitBudget = attemptsOnModel === 1 ? 1200 : 0;
      const keyHandle = await acquireKeyWithWait(env, { model, maxWaitMs: waitBudget, pollIntervalMs: 250 });
      if (!keyHandle) {
        trace.push({ model, status: "no_key_available", error: "all keys in cooldown or busy" });
        break; // No available key for this model
      }

      const apiKey = keyHandle.key;
      const attemptStart = Date.now();

      try {
        const use = { ...cfg, apiKey, provider: { ...cfg.provider, model } };
        const r = await completeGemini(env, use, payload);
        const ms = Date.now() - attemptStart;
        trace.push({ model, keyIndex: keyHandle.index, status: "ok", ms });
        keyHandle.release();
        if (dirty.size) await saveQuota(env, quota);
        return { ...r, model, trace };
      } catch (e) {
        const ms = Date.now() - attemptStart;
        last = e;
        lastModelQuotaError = e;
        keyHandle.release(e);

        if (e instanceof DailyQuotaError) {
          trace.push({ model, keyIndex: keyHandle.index, status: "daily_quota (429)", error: e.message, ms });
          modelDailyFailures++;
          continue; // Try next key for this model
        }
        if (e instanceof MinuteQuotaError) {
          trace.push({ model, keyIndex: keyHandle.index, status: "minute_quota (429)", error: e.message, ms });
          modelMinuteFailures++;
          continue; // Try next key for this model
        }
        if (e instanceof UnknownModelError) {
          trace.push({ model, keyIndex: keyHandle.index, status: "model_not_found (404)", error: e.message, ms });
          quota[e.model] = nextPacificMidnight();
          dirty.add(e.model);
          break; // A 404 model name cannot succeed with any key
        }
        if (/quota|resource_exhausted|high demand|spikes in demand|overloaded|temporarily unavailable/i.test(e?.message)) {
          trace.push({ model, keyIndex: keyHandle.index, status: "high_demand (429)", error: e?.message, ms });
          modelMinuteFailures++;
          continue;
        }
        if (/MALFORMED_RESPONSE|returned no text|empty answer/i.test(e?.message)) {
          trace.push({ model, keyIndex: keyHandle.index, status: "malformed_response (glitch)", error: e?.message, ms });
          modelMinuteFailures++;
          break;
        }
        trace.push({ model, keyIndex: keyHandle.index, status: "error", error: String(e?.message ?? e).slice(0, 200), ms });
        throw e;
      }
    }

    // FIX BUG-01: Only park the model globally if ALL keys in the pool fail on that model
    const afterNow = Date.now();
    const currentPool = getKeyPool(env);
    const currentUsable = currentPool.filter((k) => !k.disabled);
    const allKeysDailyExhausted =
      currentUsable.length > 0 &&
      currentUsable.every((k) => (k.rpdCooldownUntil > afterNow) || (k.modelRpdCooldown?.[model] > afterNow));
    const allKeysMinuteExhausted =
      currentUsable.length > 0 &&
      currentUsable.every(
        (k) =>
          (k.rpmCooldownUntil > afterNow) ||
          (k.modelRpmCooldown?.[model] > afterNow) ||
          (k.highDemandCooldownUntil > afterNow) ||
          (k.rpdCooldownUntil > afterNow) ||
          (k.modelRpdCooldown?.[model] > afterNow),
      );

    if (allKeysDailyExhausted || (currentUsable.length > 0 && modelDailyFailures >= currentUsable.length)) {
      quota[model] = lastModelQuotaError?.resetAt || nextPacificMidnight();
      dirty.add(model);
    } else if (
      allKeysMinuteExhausted ||
      (currentUsable.length > 0 && (modelDailyFailures + modelMinuteFailures) >= currentUsable.length)
    ) {
      minuteQuota.set(model, lastModelQuotaError?.resetAt || (Date.now() + 60_000));
    }
  }

  if (dirty.size) await saveQuota(env, quota);

  const afterNow = Date.now();
  const allDailyParked = pool.length > 0 && pool.every((m) => (quota[m] ?? 0) > afterNow);
  const anyParked = pool.some((m) => (quota[m] ?? 0) > afterNow || (minuteQuota.get(m) ?? 0) > afterNow);
  const fallbackReset = allDailyParked ? nextPacificMidnight() : Date.now() + 60_000;

  if (last instanceof DailyQuotaError || last instanceof MinuteQuotaError || anyParked) {
    const unparkTimes = pool.map((m) => Math.max(quota[m] ?? 0, minuteQuota.get(m) ?? 0)).filter((t) => t > afterNow);
    const resumeAt = unparkTimes.length === pool.length
      ? Math.min(...unparkTimes)
      : fallbackReset;
    const err = new PoolExhausted(resumeAt, last?.message);
    err.trace = trace;
    throw err;
  }
  const err = last ?? new PoolExhausted(fallbackReset, "no model available");
  err.trace = trace;
  throw err;
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
      const baseUrl = DEFAULT_BASE_URLS.openai;
      const model = mapModelForProvider(cfg.provider?.model, "openai", baseUrl);
      const t0 = Date.now();
      const r = await completeOpenAI(env, { ...cfg, provider: { ...cfg.provider, kind: "openai", model, baseUrl } }, payload);
      const openAiTrace = [...(e.trace || []), { provider: "openai", model, status: "ok", ms: Date.now() - t0 }];
      return { ...r, model, trace: openAiTrace };
    }
  }

  const order = ["openai", "gemini"];
  let last;
  for (const kind of order) {
    const baseUrl = kind === cfg.provider.kind ? cfg.provider.baseUrl : DEFAULT_BASE_URLS[kind];
    const model = mapModelForProvider(cfg.provider?.model, kind, baseUrl);
    const use = {
      ...cfg,
      provider: {
        ...cfg.provider,
        kind,
        model,
        baseUrl,
      },
    };
    try {
      const t0 = Date.now();
      const r = await providerFor(use)(env, use, payload);
      return { ...r, model, trace: [{ provider: kind, model, status: "ok", ms: Date.now() - t0 }] };
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

    // Check if cut point falls between a UTF-16 surrogate pair (High surrogate 0xD800-0xDBFF)
    if (cut > 0) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cut--;
      }
    }
    if (cut <= 0) {
      cut = (rest.charCodeAt(0) >= 0xd800 && rest.charCodeAt(0) <= 0xdbff && rest.length >= 2) ? 2 : 1;
    }

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

function isRtlText(s) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(String(s ?? ""));
}

/**
 * Converts markdown tables (| h1 | h2 |\n|---|---|\n| d1 | d2 |)
 * to Telegram native <table bordered striped> (Bot API 10.3+).
 */
function renderMarkdownTables(text) {
  return text.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n)(?:\|[\s\-:|]+\|\r?\n)(?:\|[^\n]+\|\r?\n?)+)/g, (_m, tableBlock) => {
    const lines = tableBlock.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return tableBlock;

    const parseCells = (line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => esc(c.trim()));

    const headers = parseCells(lines[0]);
    const rows = lines.slice(2).map(parseCells);

    const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody>`;

    return `\n<table bordered striped>${thead}${tbody}</table>\n`;
  });
}

/**
 * Converts markdown blockquotes (> quote) to Telegram <blockquote expandable>.
 */
function renderBlockquotes(text) {
  return text.replace(/(?:^|\n)((?:>[^\n]*\r?\n?)+)/g, (_m, block) => {
    const content = block
      .split(/\r?\n/)
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
    if (!content) return "";
    return `\n<blockquote expandable>${esc(content)}</blockquote>\n`;
  });
}

/**
 * Converts markdown to Telegram Rich Message HTML (Bot API 10.3+).
 * Supports <table bordered striped>, <blockquote expandable>, <details><summary>,
 * <tg-button>, <footer>, <h3>, with guaranteed closed tags.
 */
function mdToRichHtml(md, opts = {}) {
  let s = String(md ?? "").trim();
  if (!s) return "";

  const slots = [];
  const keep = (rendered) => {
    slots.push(rendered);
    return `\u0000S${slots.length - 1}\u0000`;
  };

  // 1. Preserve pre/code blocks
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) =>
    keep(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${esc(code)}</code>`));

  // 2. Render markdown tables
  s = s.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n)(?:\|[\s\-:|]+\|\r?\n)(?:\|[^\n]+\|\r?\n?)+)/g, (match) =>
    keep(renderMarkdownTables(match)));

  // 3. Render blockquotes as expandable
  s = s.replace(/(?:^|\n)((?:>[^\n]*\r?\n?)+)/g, (match) =>
    keep(renderBlockquotes(match)));

  // 4. Preserve native rich tags if already emitted by model or template
  s = s.replace(/<(tg-button-row|tg-button|table|details|summary|blockquote|figure|footer|h[1-6]|p)[^>]*>[\s\S]*?<\/\1>/gi, (tag) => keep(tag));
  s = s.replace(/<img[^>]*>/gi, (tag) => keep(tag));

  // 5. Convert headers ### Header to <h3>Header</h3>
  s = s.replace(/^#{1,4}\s+(.+)$/gm, (_m, h) => keep(`<h3>${esc(h)}</h3>`));

  // 6. Escape general text
  s = esc(s);

  // 7. Inline styling
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w\\])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w\\])_([^_\n]+)_/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2">$1</a>');

  // 8. Restore preserved slots
  s = s.replace(/\u0000S(\d+)\u0000/g, (_m, i) => slots[Number(i)]);

  // 9. Append footer if provided
  if (opts.footer) {
    s += `\n<footer>${esc(opts.footer)}</footer>`;
  }

  return s.trim();
}

/** Base64-encode bytes in chunks, so a multi-megabyte buffer cannot blow the stack. */
function toBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
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

function isCommand(text, myBotUsername) {
  const m = /^\/(start|help|ping)(?:@(\S+))?(?:\s|$)/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const targetBot = m[2];
  if (targetBot && myBotUsername) {
    const cleanTarget = targetBot.toLowerCase().replace(/^@/, "");
    const cleanMine = myBotUsername.toLowerCase().replace(/^@/, "");
    if (cleanTarget !== cleanMine) {
      return null;
    }
  }
  return m[1].toLowerCase();
}

/** Groups: only when the wake word appears, or when Sayyad itself is replied to. */
function shouldAnswer(msg, botId, chatType, myBotUsername) {
  if (chatType === "private") return true;
  const text = normalizeFa(msg.text || msg.caption || "");
  if (isCommand(text, myBotUsername)) return true;
  if (/(?<![\p{L}])سید(?![\p{L}])/u.test(text)) return true;
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
- تو قابلیت ارسال ویس و پیام صوتی (Voice Message) داری. اگر کاربر خواست با صدا، ویس یا پادکست پاسخ دهی، یک متن روان، گفتاری و صمیمی برای خوانده‌شدن تولید کن و هرگز نگو ویس نمی‌فرستم یا توانایی ارسال صدا ندارم.
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
function buildSystemPrompt(cfg, opts = {}) {
  const persona = cfg.personas?.[cfg.mode] ?? DEFAULT_PERSONAS.smart;
  const extra = String(cfg.extra ?? "").trim();
  const voiceNote = opts?.isVoice
    ? "دستور ارسال صوت: این پاسخ قرار است به صورت ویس و فایل صوتی برای کاربر خوانده شود. پاسخی طبیعی، با لحن گفتاری، روان و شنیداری تولید کن و هرگز نگو ویس نمی‌فرستی."
    : "";
  return [BASE_RULES, persona, extra ? `دستورهای اضافه‌ی مدیر:\n${extra}` : "", voiceNote].filter(Boolean).join("\n\n");
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

if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.timingSafeEqual !== "function" && typeof crypto.timingSafeEqual === "function") {
  try {
    crypto.subtle.timingSafeEqual = crypto.timingSafeEqual;
  } catch {}
}

/** Constant-time comparison to prevent timing attacks. */
function timingSafeEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    const enc = new TextEncoder();
    const bufA = enc.encode(a);
    const bufB = enc.encode(b);
    if (bufA.byteLength !== bufB.byteLength) return false;
    const fn = crypto.subtle?.timingSafeEqual ?? crypto.timingSafeEqual;
    if (typeof fn === "function") return fn(bufA, bufB);
    let diff = 0;
    for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
    return diff === 0;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    const fn = crypto.subtle?.timingSafeEqual ?? crypto.timingSafeEqual;
    if (typeof fn === "function") return fn(a, b);
    let diff = 0;
    for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  return false;
}

/** Constant-time password verification using SHA-256 digest + timingSafeEqual. */
async function verifyPassword(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const bufA = new Uint8Array(hashA);
  const bufB = new Uint8Array(hashB);
  const fn = crypto.subtle?.timingSafeEqual ?? crypto.timingSafeEqual;
  if (typeof fn === "function") return fn(bufA, bufB);
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

const failedLoginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function resetLoginRateLimit() {
  failedLoginAttempts.clear();
}

function getClientIp(req) {
  if (req?.headers?.get && typeof req.headers.get === "function") {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const xri = req.headers.get("x-real-ip");
    if (xri) return xri.trim();
  }
  if (req?.headers) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    const xri = req.headers["x-real-ip"];
    if (xri) return String(xri).trim();
  }
  if (req?.socket?.remoteAddress) return req.socket.remoteAddress;
  return "127.0.0.1";
}

function isLoginRateLimited(ip) {
  const ipKey = String(ip || "127.0.0.1");
  const now = Date.now();
  const list = failedLoginAttempts.get(ipKey) || [];
  const recent = list.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length !== list.length) {
    if (recent.length === 0) failedLoginAttempts.delete(ipKey);
    else failedLoginAttempts.set(ipKey, recent);
  }
  return recent.length >= MAX_FAILED_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const ipKey = String(ip || "127.0.0.1");
  const now = Date.now();
  const list = failedLoginAttempts.get(ipKey) || [];
  const recent = list.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  // Refresh insertion order so the most recently failing IP is moved to the tail (LRU)
  failedLoginAttempts.delete(ipKey);
  failedLoginAttempts.set(ipKey, recent);

  if (failedLoginAttempts.size > 1000) {
    for (const [k, times] of failedLoginAttempts.entries()) {
      const valid = times.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (valid.length === 0) {
        failedLoginAttempts.delete(k);
      } else if (valid.length !== times.length) {
        failedLoginAttempts.set(k, valid);
      }
    }
    while (failedLoginAttempts.size > 1000) {
      const oldestKey = failedLoginAttempts.keys().next().value;
      if (oldestKey !== undefined) {
        failedLoginAttempts.delete(oldestKey);
      } else {
        break;
      }
    }
  }
}

function clearFailedLogin(ip) {
  failedLoginAttempts.delete(String(ip || "127.0.0.1"));
}

function isHttps(req) {
  try {
    if (req.url && new URL(req.url).protocol === "https:") return true;
  } catch {}
  let proto = "";
  if (req?.headers?.get && typeof req.headers.get === "function") {
    proto = req.headers.get("x-forwarded-proto") ?? "";
    const cfVisitor = req.headers.get("cf-visitor") ?? "";
    if (cfVisitor.includes('"https"')) return true;
  } else if (req?.headers) {
    proto = req.headers["x-forwarded-proto"] ?? "";
  }
  return proto.toLowerCase() === "https";
}

/** Stateless session: the cookie is an HMAC of the admin password, so nothing is stored. */
async function signSecret(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sayyad-admin-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(req, name) {
  let raw = "";
  if (req?.headers?.get && typeof req.headers.get === "function") {
    raw = req.headers.get("cookie") ?? "";
  } else if (req?.headers?.cookie) {
    raw = req.headers.cookie ?? "";
  }
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
    const want = await signSecret(env.ADMIN_PASSWORD);
    return timingSafeEqual(cookie, want);
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
.tracebox{background:#080c14;border:1px solid #1f293d;border-radius:8px;padding:12px;margin-top:10px;font-family:ui-monospace,monospace;font-size:12px;color:#94a3b8;direction:ltr;text-align:left}
.tracetitle{font-weight:700;color:#38bdf8;margin-bottom:8px;font-size:13px}
.traceline{margin:5px 0}
.traceul{margin:4px 0 8px 18px;padding:0;list-style:disc}
.traceul li{margin:3px 0}
.tracebox code{background:#172033;padding:2px 5px;border-radius:4px;color:#e2e8f0;font-size:11px}
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
  setb("enabled", c.enabled !== false);
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
  if (it.ms !== undefined) sum.appendChild(el("span", "tag", it.ms + " ms"));
  if (it.voice !== undefined) {
    if (it.voice) {
      sum.appendChild(el("span", "tag on", "🎙️ voice"));
    } else if (it.verr) {
      sum.appendChild(el("span", "tag err", "voice fallback"));
    }
  } else if (it.verr) {
    sum.appendChild(el("span", "tag err", "voice err"));
  }
  sum.appendChild(el("span", "where", (it.c && it.c.t) || ""));
  sum.appendChild(el("span", "prev", (it.k || "") + " · " + (it.x || "").replace(/\\s+/g, " ").slice(0, 70)));
  det.appendChild(sum);
  var body = el("div", "body");
  var uid = it.u ? it.u.id : "";
  var cid = it.c ? it.c.id : "";
  var metaStr = "user " + uid + "  ·  chat " + cid + "  ·  message " + it.m + "  ·  " + stamp(it.t);
  if (it.model) metaStr += "  ·  model: " + it.model;
  if (it.ms !== undefined) metaStr += "  ·  " + it.ms + " ms";
  if (it.tgOut) metaStr += "  ·  out: " + it.tgOut;
  body.appendChild(el("div", "meta", metaStr));
  if (it.reason) {
    body.appendChild(el("div", "meta", "info: " + it.reason));
  }
  var inMsg = el("div", "msg");
  inMsg.appendChild(el("b", null, "User (" + (it.k || "text") + "): "));
  inMsg.appendChild(document.createTextNode(it.x || "(no text)"));
  body.appendChild(inMsg);
  if (it.reply) {
    var rep = el("div", "replybox");
    rep.appendChild(el("b", null, "AI: "));
    rep.appendChild(document.createTextNode(it.reply));
    body.appendChild(rep);
  }
  if (it.verr) {
    var ver = el("div", "errbox");
    ver.appendChild(el("b", null, "Voice Error: "));
    ver.appendChild(document.createTextNode(it.verr));
    body.appendChild(ver);
  }
  if (it.err) {
    var er = el("div", "errbox");
    er.appendChild(el("b", null, "Error: "));
    er.appendChild(document.createTextNode(it.err));
    body.appendChild(er);
  }
  if (it.trace) {
    var trBox = el("div", "tracebox");
    trBox.appendChild(el("div", "tracetitle", "⚙️ Execution Pipeline Trace:"));

    if (it.trace.intent) {
      var intLine = el("div", "traceline");
      intLine.appendChild(el("b", null, "• Intent: "));
      var isReq = it.trace.intent.requested;
      intLine.appendChild(el("span", "tag" + (isReq ? " on" : ""), isReq ? "🎙️ Voice Requested" : "💬 Text Only"));
      intLine.appendChild(document.createTextNode(" via "));
      intLine.appendChild(el("code", null, it.trace.intent.method || "default"));
      if (it.trace.intent.reason) {
        intLine.appendChild(document.createTextNode(" (" + it.trace.intent.reason + ")"));
      }
      trBox.appendChild(intLine);
    }

    if (it.trace.llm) {
      var llmLine = el("div", "traceline");
      llmLine.appendChild(el("b", null, "• LLM Routing: "));
      if (it.trace.llm.chosenModel) {
        llmLine.appendChild(document.createTextNode("Selected "));
        llmLine.appendChild(el("code", null, it.trace.llm.chosenModel));
      }
      trBox.appendChild(llmLine);

      if (Array.isArray(it.trace.llm.attempts) && it.trace.llm.attempts.length) {
        var attUl = el("ul", "traceul");
        it.trace.llm.attempts.forEach(function(att) {
          var li = el("li", null);
          var icon = att.status === "ok" ? "✅ " : "⚠️ ";
          li.appendChild(document.createTextNode(icon));
          li.appendChild(el("code", null, att.model));
          if (att.keyIndex !== undefined) {
            li.appendChild(document.createTextNode(" (Key #" + (att.keyIndex + 1) + ")"));
          }
          li.appendChild(document.createTextNode(": "));
          li.appendChild(el("b", null, att.status));
          if (att.ms !== undefined) {
            li.appendChild(document.createTextNode(" [" + att.ms + "ms]"));
          }
          if (att.error) {
            li.appendChild(document.createTextNode(" — " + att.error));
          }
          attUl.appendChild(li);
        });
        trBox.appendChild(attUl);
      }
    }

    if (it.trace.voice) {
      var vLine = el("div", "traceline");
      var isVOk = it.trace.voice.status === "delivered";
      vLine.appendChild(el("b", null, "• Voice Synthesis: "));
      vLine.appendChild(document.createTextNode((isVOk ? "✅ " : "❌ ") + "Status: "));
      vLine.appendChild(el("b", null, it.trace.voice.status));
      if (it.trace.voice.chosenModel) {
        vLine.appendChild(document.createTextNode(" (Model: "));
        vLine.appendChild(el("code", null, it.trace.voice.chosenModel));
        vLine.appendChild(document.createTextNode(")"));
      }
      trBox.appendChild(vLine);

      if (Array.isArray(it.trace.voice.attempts) && it.trace.voice.attempts.length) {
        var vUl = el("ul", "traceul");
        it.trace.voice.attempts.forEach(function(vAtt) {
          var li = el("li", null);
          li.appendChild(document.createTextNode(vAtt.ok ? "✅ " : "❌ "));
          li.appendChild(el("code", null, vAtt.model));
          li.appendChild(document.createTextNode(": " + (vAtt.ok ? "Success" : "Failed")));
          if (vAtt.ms !== undefined) {
            li.appendChild(document.createTextNode(" [" + vAtt.ms + "ms]"));
          }
          if (vAtt.error) {
            li.appendChild(document.createTextNode(" — " + vAtt.error));
          }
          vUl.appendChild(li);
        });
        trBox.appendChild(vUl);
      }
    }

    if (it.trace.delivery) {
      var dLine = el("div", "traceline");
      dLine.appendChild(el("b", null, "• Telegram Delivery: "));
      var dKind = it.trace.delivery.kind === "voice" ? "🎙️ Voice Audio File (WAV)"
                : it.trace.delivery.kind === "text_fallback" ? "⚠️ Text Fallback (Voice failed)"
                : "💬 Standard Text";
      dLine.appendChild(el("span", "tag" + (it.trace.delivery.kind === "voice" ? " on" : ""), dKind));
      if (it.trace.delivery.reason) {
        dLine.appendChild(document.createTextNode(" (" + it.trace.delivery.reason + ")"));
      }
      trBox.appendChild(dLine);
    }

    body.appendChild(trBox);
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
    const ip = getClientIp(req);
    if (isLoginRateLimited(ip)) {
      return new Response(renderLogin("Too many failed login attempts. Please try again in 5 minutes."), {
        status: 429,
        headers: { "content-type": "text/html; charset=utf-8", "retry-after": "300" },
      });
    }

    const ct = req.headers.get("content-type") ?? "";
    const body = ct.includes("application/json")
      ? await req.json().catch(() => ({}))
      : Object.fromEntries(await req.formData());

    const ok = env.ADMIN_PASSWORD && (await verifyPassword(body.password, env.ADMIN_PASSWORD));
    if (!ok) {
      recordFailedLogin(ip);
      return new Response(renderLogin("Wrong password."), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    clearFailedLogin(ip);
    const secure = isHttps(req) ? "; Secure" : "";
    const cookie = `${COOKIE}=${await signSecret(env.ADMIN_PASSWORD)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`;
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

  if (path === "/admin/api/keys") {
    if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
    const rawKeys = getKeyPoolStatus(env);
    const keys = rawKeys.map((item) => {
      const key = item.key;
      const masked =
        typeof key === "string"
          ? (key.length > 10 ? key.slice(0, 6) + "..." + key.slice(-4) : (key.length > 2 ? key.slice(0, 2) + "***" : "***"))
          : key;
      const lastError =
        typeof item.lastError === "string"
          ? item.lastError.replace(/key=[^&\s]+/gi, "key=[REDACTED]")
          : item.lastError;
      return { ...item, key: masked, lastError };
    });
    return json({ count: keys.length, keys });
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
let botUsernameCache = null;

/** The bot's own id, fetched once per isolate. Telegram asks for it on every answer. */
async function botId(env) {
  if (botIdCache) return botIdCache;
  const me = await getMe(env.TELEGRAM_BOT_TOKEN);
  if (!me?.ok) throw new Error(`getMe failed: ${me?.description ?? "unknown"}`);
  botIdCache = me.result.id;
  botUsernameCache = me.result.username;
  return botIdCache;
}

async function botUsername(env) {
  if (botUsernameCache) return botUsernameCache;
  const me = await getMe(env.TELEGRAM_BOT_TOKEN);
  if (!me?.ok) return null;
  botIdCache = me.result.id;
  botUsernameCache = me.result.username;
  return botUsernameCache;
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
const sendChatAction = (token, chatId, action = "typing", threadId) => {
  const payload = { chat_id: chatId, action };
  const tid = typeof threadId === "object" ? (threadId?.message_thread_id ?? threadId?.threadId) : threadId;
  if (tid) payload.message_thread_id = tid;
  return tg(token, "sendChatAction", payload);
};

/**
 * Send a rich message (Bot API 10.3+) supporting native tables, expandable quotes,
 * buttons and native RTL. Returns telegram API response or null.
 */
async function sendRichMessage(token, chatId, html, replyTo, isRtl = true) {
  const base = { chat_id: chatId };
  if (replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const payload = {
    ...base,
    rich_message: { html, is_rtl: Boolean(isRtl) },
  };

  try {
    return await tg(token, "sendRichMessage", payload);
  } catch {
    return null;
  }
}

/** Send a message, trying HTML first and degrading to plain text if Telegram objects. */
async function sendText(token, chatId, text, replyTo, threadIdOrOpts) {
  const base = { chat_id: chatId };
  const tid = typeof threadIdOrOpts === "object"
    ? (threadIdOrOpts?.message_thread_id ?? threadIdOrOpts?.threadId)
    : threadIdOrOpts;
  if (tid) base.message_thread_id = tid;
  // reply_parameters, not reply_to_message_id: a deleted target never costs us the message.
  if (replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const first = await tg(token, "sendMessage", { ...base, text: mdToHtml(text), parse_mode: "HTML" });
  if (first?.ok) return first;

  const retry = await tg(token, "sendMessage", { ...base, text });
  if (!retry?.ok) throw new Error(`sendMessage failed: ${retry?.description ?? "unknown"}`);
  return retry;
}

/**
 * Send a long answer using standard Telegram sendMessage (HTML parse_mode).
 */
async function sendLong(token, chatId, text, replyTo, opts = {}) {
  const options = typeof opts === "object" && opts !== null ? opts : { message_thread_id: opts };
  const tid = options.message_thread_id ?? options.threadId;
  const chunks = splitText(text, 3200);

  for (const chunk of chunks) {
    const rendered = mdToHtml(chunk).length;
    if (rendered <= 3900) {
      await sendText(token, chatId, chunk, replyTo, tid);
      continue;
    }
    const narrower = Math.max(600, Math.floor((chunk.length * 3800) / rendered));
    for (const sub of splitText(chunk, narrower)) {
      await sendText(token, chatId, sub, replyTo, tid);
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
async function sendAudioFile(token, chatId, bytes, fileName, mime, replyTo, threadIdOrOpts) {
  const blob = () => new Blob([bytes], { type: mime });
  const tid = typeof threadIdOrOpts === "object"
    ? (threadIdOrOpts?.message_thread_id ?? threadIdOrOpts?.threadId)
    : threadIdOrOpts;

  const post = (method, field) => {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (tid) form.append("message_thread_id", String(tid));
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

// ------------------------------ src/nodeWs.js ------------------------------
// Native zero-dependency WebSocket client for Node.js (RFC 6455 over node:https).
// Enables high-performance WebSocket connections in Node.js 18+ without external packages.





class NodeWebSocket {
  constructor(urlStr) {
    this.url = new URL(urlStr);
    this.readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
    this.binaryType = "arraybuffer";
    this._listeners = { message: [], open: [], close: [], error: [] };
    this._socket = null;
    this.fragments = [];
    this.fragOpcode = 0;
    this._closedEmitted = false;
    this._connect();
  }

  addEventListener(type, fn, options) {
    if (!this._listeners[type] || typeof fn !== "function") return;
    if (options && options.once) {
      const onceWrapper = (event) => {
        this.removeEventListener(type, onceWrapper);
        fn(event);
      };
      onceWrapper._original = fn;
      this._listeners[type].push(onceWrapper);
    } else {
      this._listeners[type].push(fn);
    }
  }

  removeEventListener(type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter(
        (cb) => cb !== fn && cb._original !== fn,
      );
    }
  }

  _emit(type, event) {
    const list = this._listeners[type] || [];
    for (const fn of [...list]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`NodeWebSocket listener error (${type}):`, err);
      }
    }
    const propHandler = this[`on${type}`];
    if (typeof propHandler === "function") {
      try {
        propHandler(event);
      } catch (err) {
        console.error(`NodeWebSocket property handler error (on${type}):`, err);
      }
    }
  }

  _emitClose(event = {}) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = 3;
    this.fragments = [];
    this.fragOpcode = 0;
    this._emit("close", {
      code: event.code ?? 1000,
      reason: event.reason ?? "",
      wasClean: event.wasClean ?? (event.code === 1000),
    });
  }

  _connect() {
    const isWss = this.url.protocol === "wss:" || this.url.protocol === "https:";
    const transport = isWss ? https : http;
    const defaultPort = isWss ? 443 : 80;
    const port = this.url.port ? parseInt(this.url.port, 10) : defaultPort;
    const secKey = crypto.randomBytes(16).toString("base64");

    const req = transport.request({
      hostname: this.url.hostname,
      port,
      path: this.url.pathname + this.url.search,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": secKey,
        "Sec-WebSocket-Version": "13",
      },
    });

    this._req = req;

    // Handle non-101 responses (e.g. HTTP 403 Forbidden, 429 Too Many Requests, 404, 500)
    req.on("response", (res) => {
      res.resume(); // Drain and discard
      res.on("end", () => {
        try { req.destroy(); } catch {}
      });
      const msg = `Unexpected server response: ${res.statusCode} ${res.statusMessage || ""}`.trim();
      const err = new Error(msg);
      this._emit("error", err);
      this._emitClose({ code: 1006, reason: msg, wasClean: false });
    });

    req.on("upgrade", (res, socket, head) => {
      const expectedAccept = crypto
        .createHash("sha1")
        .update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      const actualAccept = res.headers["sec-websocket-accept"];
      if (actualAccept !== expectedAccept) {
        const err = new Error("Sec-WebSocket-Accept header mismatch or missing");
        this._emit("error", err);
        this._emitClose({ code: 1002, reason: err.message, wasClean: false });
        socket.destroy();
        return;
      }

      if (this.readyState === 2 || this.readyState === 3) {
        socket.destroy();
        return;
      }

      this._socket = socket;

      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

      const processFrames = () => {
        while (buffer.length >= 2) {
          const byte1 = buffer[0];
          const byte2 = buffer[1];
          const fin = (byte1 & 0x80) !== 0;
          const opcode = byte1 & 0x0f;
          let payloadLen = byte2 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < offset + 2) break;
            payloadLen = buffer.readUInt16BE(offset);
            offset += 2;
          } else if (payloadLen === 127) {
            if (buffer.length < offset + 8) break;
            const bigLen = buffer.readBigUInt64BE(offset);
            if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
              this._emit("error", new Error("Payload length exceeds safe integer limit"));
              socket.destroy();
              return;
            }
            payloadLen = Number(bigLen);
            offset += 8;
          }

          // RFC 6455 Section 5.1: A server MUST NOT mask any frames that it sends to the client.
          const isMasked = (byte2 & 0x80) !== 0;
          if (isMasked) {
            const err = new Error("Protocol error: server frame MUST NOT be masked (RFC 6455 Section 5.1)");
            this._emit("error", err);
            this.close(1002, "Protocol error: masked frame from server");
            return;
          }

          if (payloadLen > 32 * 1024 * 1024) {
            const err = new Error("Message too big: payload exceeds 32MB limit");
            this._emit("error", err);
            this.close(1009, "Message too big");
            return;
          }

          if (buffer.length < offset + payloadLen) break;

          const payload = buffer.subarray(offset, offset + payloadLen);
          buffer = buffer.subarray(offset + payloadLen);
          if (buffer.length === 0) buffer = Buffer.alloc(0);

          // Control frames validation (RFC 6455 5.5: must not be fragmented and payload <= 125)
          if (opcode >= 8 && (!fin || payloadLen > 125)) {
            const err = new Error("Protocol error: fragmented or oversized control frame");
            this._emit("error", err);
            this.close(1002, "Protocol error");
            return;
          }

          if (opcode === 8) {
            // CLOSE frame from server (RFC 6455 Section 5.5.1)
            if (payloadLen === 1) {
              const err = new Error("Protocol error: close frame with 1-byte payload");
              this._emit("error", err);
              this.close(1002, "Protocol error");
              return;
            }
            let code = 1000;
            let reason = "server closed";
            if (payload.length >= 2) {
              code = payload.readUInt16BE(0);
              if (code < 1000 || (code >= 1004 && code <= 1006) || code === 1015 || (code >= 1016 && code <= 2999) || code >= 5000) {
                const err = new Error(`Protocol error: invalid close code ${code}`);
                this._emit("error", err);
                this.close(1002, "Protocol error");
                return;
              }
              if (payload.length > 2) {
                try {
                  reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
                } catch {
                  const err = new Error("Protocol error: close reason is not valid UTF-8");
                  this._emit("error", err);
                  this.close(1002, "Protocol error");
                  return;
                }
              } else {
                reason = "";
              }
            }
            // Reply with close frame if not already closing
            if (this.readyState === 1) {
              this.readyState = 2;
              try {
                const echoBuf = Buffer.alloc(2);
                echoBuf.writeUInt16BE(code, 0);
                this._sendFrame(0x08, echoBuf);
              } catch {}
            }
            socket.end();
            this._emitClose({ code, reason, wasClean: true });
            return;
          } else if (opcode === 9) {
            // PING -> reply masked PONG containing exact incoming payload (RFC 6455 5.5.3)
            try {
              this._sendFrame(0x0a, payload);
            } catch {}
          } else if (opcode === 10) {
            // PONG -> keepalive response, ignore
          } else if (opcode === 1 || opcode === 2 || opcode === 0) {
            // Fragmentation support (RFC 6455 Section 5.4)
            if (opcode !== 0) {
              if (this.fragOpcode !== 0) {
                const err = new Error("Protocol error: new message started before previous fragment finished");
                this._emit("error", err);
                this.close(1002, "Protocol error");
                return;
              }
              this.fragOpcode = opcode;
              this.fragments = [Buffer.from(payload)];
            } else {
              if (!this.fragOpcode) {
                // Continuation frame without prior initiating frame
                const err = new Error("Protocol error: unexpected continuation frame");
                this._emit("error", err);
                this.close(1002, "Protocol error");
                return;
              }
              this.fragments.push(Buffer.from(payload));
            }

            const totalAccum = this.fragments.reduce((sum, f) => sum + f.length, 0);
            if (totalAccum > 32 * 1024 * 1024) {
              const err = new Error("Message too big: fragmented message exceeds 32MB limit");
              this._emit("error", err);
              this.close(1009, "Message too big");
              return;
            }

            if (fin) {
              const fullPayload = Buffer.concat(this.fragments);
              const finalOpcode = this.fragOpcode;
              this.fragments = [];
              this.fragOpcode = 0;

              if (finalOpcode === 1) {
                // TEXT (RFC 6455 Section 5.6)
                let text;
                try {
                  text = new TextDecoder("utf-8", { fatal: true }).decode(fullPayload);
                } catch {
                  const err = new Error("Protocol error: invalid UTF-8 in text frame");
                  this._emit("error", err);
                  this.close(1007, "Invalid UTF-8");
                  return;
                }
                this._emit("message", { data: text });
              } else if (finalOpcode === 2) {
                // BINARY
                const arr = new Uint8Array(fullPayload);
                this._emit("message", { data: arr });
              }
            }
          } else {
            // Reserved / unknown opcode (RFC 6455 Section 5.2)
            const err = new Error(`Protocol error: unknown opcode ${opcode}`);
            this._emit("error", err);
            this.close(1002, "Protocol error");
            return;
          }
        }
      };

      // Attach socket listeners BEFORE emitting open to avoid unhandled error crash
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        processFrames();
      });

      socket.on("close", () => {
        const wasClosing = this.readyState === 2;
        this._emitClose({
          code: wasClosing ? (this._closeCode ?? 1000) : 1006,
          reason: wasClosing ? (this._closeReason ?? "") : "socket closed",
          wasClean: wasClosing,
        });
      });

      socket.on("error", (err) => {
        this._emit("error", err);
        this._emitClose({ code: 1006, reason: err.message, wasClean: false });
      });

      this.readyState = 1; // OPEN
      this._emit("open", {});

      if (buffer.length >= 2) {
        processFrames();
      }
    });

    req.on("error", (err) => {
      this._emit("error", err);
      this._emitClose({ code: 1006, reason: err.message, wasClean: false });
    });

    req.end();
  }

  _sendFrame(opcode, payloadBuffer) {
    if ((this.readyState !== 1 && (opcode !== 0x08 || this.readyState !== 2)) || !this._socket || !this._socket.writable) {
      throw new Error("WebSocket is not open");
    }

    const payload = Buffer.isBuffer(payloadBuffer)
      ? payloadBuffer
      : typeof payloadBuffer === "string"
      ? Buffer.from(payloadBuffer, "utf8")
      : payloadBuffer instanceof Uint8Array || payloadBuffer instanceof ArrayBuffer
      ? Buffer.from(payloadBuffer)
      : payloadBuffer
      ? Buffer.from(payloadBuffer)
      : Buffer.alloc(0);

    const len = payload.length;
    let header;
    let offset = 0;
    const firstByte = 0x80 | (opcode & 0x0f);

    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = firstByte;
      header[1] = 0x80 | len; // Mask bit = 1
      offset = 2;
    } else if (len <= 65535) {
      header = Buffer.alloc(8);
      header[0] = firstByte;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      header = Buffer.alloc(14);
      header[0] = firstByte;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      offset = 10;
    }

    const mask = crypto.randomBytes(4);
    mask.copy(header, offset, 0, 4);

    const maskedPayload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }

    this._socket.write(Buffer.concat([header, maskedPayload]));
  }

  send(data) {
    if (this.readyState !== 1 || !this._socket) {
      throw new Error("WebSocket is not open");
    }

    const isBinary = Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer;
    const payload = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
      ? Buffer.from(data, "utf8")
      : isBinary
      ? Buffer.from(data)
      : Buffer.from(String(data ?? ""), "utf8");

    this._sendFrame(isBinary ? 0x02 : 0x01, payload);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 2 || this.readyState === 3) return;
    const wasConnecting = this.readyState === 0;
    this.readyState = 2;
    this._closeCode = code;
    this._closeReason = reason;
    if (this._req && wasConnecting) {
      try {
        this._req.destroy();
      } catch {}
    }
    if (this._socket) {
      try {
        const reasonBuf = reason ? Buffer.from(reason, "utf8") : Buffer.alloc(0);
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        if (reasonBuf.length > 0) {
          reasonBuf.copy(payload, 2);
        }
        this._sendFrame(0x08, payload);
      } catch {}
      try {
        this._socket.end();
      } catch {}
    } else {
      this._emitClose({ code, reason, wasClean: true });
    }
  }
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
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

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
async function connectLiveSocket(key) {
  const wsUrl = LIVE_ENDPOINT.replace(/^http/i, "ws") + `?key=${encodeURIComponent(key)}`;

  if (typeof globalThis.WebSocket === "function") {
    try {
      const ws = new globalThis.WebSocket(wsUrl);
      if (ws) return ws;
    } catch {
      /* fallback */
    }
  }

  // Cloudflare Workers outbound WebSocket (fetch with Upgrade header)
  try {
    const res = await fetch(`${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      headers: { Upgrade: "websocket" },
    });
    if (res?.webSocket) return res.webSocket;
  } catch {
    /* fetch() throws in Node.js on Upgrade header */
  }

  // Node.js fallback: pure built-in https WebSocket client
  if (typeof process !== "undefined" && process?.versions?.node) {
    return new NodeWebSocket(wsUrl);
  }

  throw new Error("live voice: WebSocket upgrade was refused");
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
async function speakOnce(key, model, words, timeoutMs) {
  const ws = await connectLiveSocket(key);

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
        const detail =
          msg.error.message ??
          (msg.error.status
            ? `${msg.error.status}${msg.error.code ? ` (${msg.error.code})` : ""}`
            : msg.error.code) ??
          JSON.stringify(msg.error);
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
    ws.addEventListener("close", (ev) =>
      queue.then(() => {
        const closeDetail = ev?.reason ? `connection closed: ${ev.reason}` : "connection closed before any audio";
        finish(chunks.length ? null : new Error(`live voice: ${closeDetail}`), chunks.length ? pcmToWav(concat(chunks)) : undefined);
      }),
    );
    ws.addEventListener("error", (ev) =>
      queue.then(() => {
        const errMsg = ev?.message || ev?.error?.message || (typeof ev === "string" ? ev : "connection error");
        finish(chunks.length ? null : new Error(`live voice: ${errMsg}`), chunks.length ? pcmToWav(concat(chunks)) : undefined);
      }),
    );

    if (typeof ws.accept === "function") ws.accept(); // Workers' outbound sockets need this
    try {
      ws.binaryType = "arraybuffer"; // never deal with Blobs
    } catch {
      /* read-only in some runtimes */
    }

    const sendSetup = () => {
      send({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: { parts: [{ text: SPEAK_PROMPT }] },
        },
      });
    };

    if (ws.readyState === 0) {
      ws.addEventListener("open", sendSetup, { once: true });
    } else {
      sendSetup();
    }
  });
}

/**
 * Say `text` out loud. Resolves with a WAV (Uint8Array), throws on anything unexpected.
 * A turn that produced *some* audio but died before `turnComplete` still counts as a
 * success — a slightly short answer beats an error message.
 */
async function speak(env, cfg, text, opts = {}) {
  const rawKeys = extractKeys(env);
  if (!rawKeys.length && !env?.GEMINI_API_KEY) {
    throw new Error("live voice: GEMINI_API_KEY is not set");
  }

  const words = spokenText(text);
  if (!words) throw new Error("live voice: nothing to say");

  const timeoutMs = opts.timeoutMs ?? liveTimeoutMs;
  const startAt = Date.now();
  const primary = cfg?.voice?.model || DEFAULT_MODEL;
  const pool = [primary, ...FALLBACK_VOICE_MODELS.filter((m) => m !== primary)];

  let lastErr;
  const attempts = [];
  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    const elapsed = Date.now() - startAt;
    const remaining = timeoutMs - elapsed;
    if (i > 0 && remaining < 2000) break;

    const keyHandle = await acquireKeyWithWait(env, { model, maxWaitMs: 1200, pollIntervalMs: 300 });
    const key = keyHandle?.key || env?.GEMINI_API_KEY || rawKeys[0];

    const t0 = Date.now();
    try {
      const wav = await speakOnce(key, model, words, Math.max(1, remaining));
      keyHandle?.release();
      attempts.push({ model, ok: true, ms: Date.now() - t0 });
      try {
        opts.onTrace?.({ attempts, chosenModel: model, status: "ok" });
      } catch {}
      return wav;
    } catch (e) {
      const clean = String(e?.message ?? e).replace(/key=[^&\s]+/gi, "key=[REDACTED]");
      lastErr = new Error(clean);
      keyHandle?.release(lastErr);
      attempts.push({ model, ok: false, error: clean.slice(0, 150), ms: Date.now() - t0 });
      try {
        opts.onTrace?.({ attempts, lastError: clean.slice(0, 150), status: "failed" });
      } catch {}
      if (!/(?:model|not found|unknown|404|unsupported|unavailable|closed|backend exploded|connection|disconnect|refused|failed|timeout|timedout|hang up|reset|econnreset|etimedout|500|502|503|504|server error|no audio|without audio|429|quota|resource_exhausted|rate.?limit)/i.test(clean)) {
        throw lastErr;
      }
    }
  }

  throw lastErr ?? new Error("live voice: all voice models failed");
}

/**
 * Fast regex for detecting explicit negative intent (user definitely does NOT want audio).
 */
const VOICE_NEGATIVE_RE =
  /(?:ویس|صدا|صوتی|voice)\s*(?:نفرست|نده|نگو|نمیخوام|نباشه|نکن|نزن)|(?:متنی|تکست|نوشتاری)\s*(?:بگو|بفرست|بنویس|جواب بده)/iu;

/**
 * Fast regex for detecting explicit positive voice requests without waiting for LLM.
 */
const VOICE_POSITIVE_RE =
  /(?:ویس|صدا|صوتی|voice)[^\n.!؟?]{0,35}(?:بفرست|بده|بگو|بخون|توضیح بده|تعریف کن|ضبط کن)|(?:با|به صورت|به شکل)\s*(?:ویس|صدا|صوتی)|(?:برام|برامون)\s*بخون/iu;

/**
 * Quick hint check: If the message contains none of these words, it's definitely not voice-related.
 * Saves an LLM call for 99% of normal messages.
 */
const VOICE_HINT_RE =
  /(?:ویس|صدا|صوتی|بخون|بشنو|گوش|تعریف|بلند|رادیو|voice|audio|speak|listen)/iu;

/**
 * Prompt for Gemma 4 to classify colloquial/indirect voice requests.
 */
const INTENT_SYSTEM_PROMPT =
  "وظیفه شما فقط و فقط تشخیص این است که آیا کاربر در متن پیام، درخواست پاسخ صوتی یا ویس کرده است یا خیر.\n" +
  "اگر کاربر حتی به صورت غیرمستقیم (مثلاً: «حوصله خوندن ندارم برام تعریف کن»، «تو ماشینم بگو بشنوم»، «بلند بگو») خواسته پاسخ به شکل صدا/ویس باشد، فقط بنویس: YES\n" +
  "اگر پیام یک متن معمولی است یا کاربر گفته ویس نفرست، فقط بنویس: NO\n" +
  "هیچ توضیح اضافه‌ای نده. پاسخ فقط یک کلمه باشد: YES یا NO";

/**
 * Detect if user message is asking for a voice reply.
 * Uses fast regex for clear cases, and Gemma 4 for colloquial/nuanced Persian requests.
 */
async function detectVoiceIntent(env, text, cfg, traceContext = null) {
  if (cfg?.voice?.enabled === false) {
    if (traceContext) traceContext.intent = { requested: false, reason: "voice disabled in config" };
    return false;
  }
  if (!text || typeof text !== "string") return false;
  const clean = text.trim();
  if (!clean) return false;

  // 1. If text has no hint of voice/audio words at all, skip immediately without LLM call
  if (!VOICE_HINT_RE.test(clean)) {
    if (traceContext) traceContext.intent = { requested: false, method: "fast_hint_filter", reason: "no voice keywords in text" };
    return false;
  }

  // 2. Fast negative check
  if (VOICE_NEGATIVE_RE.test(clean)) {
    if (traceContext) traceContext.intent = { requested: false, method: "fast_regex_negative", reason: "explicit negative request" };
    return false;
  }

  // 3. Fast positive check
  if (VOICE_POSITIVE_RE.test(clean)) {
    if (traceContext) traceContext.intent = { requested: true, method: "fast_regex_positive", reason: "keyword matched: " + clean.slice(0, 40) };
    return true;
  }

  // 4. Nuanced / colloquial check via Gemma 4
  try {
    const classifierCfg = {
      ...cfg,
      provider: {
        ...cfg?.provider,
        kind: "gemini",
        baseUrl: cfg?.provider?.kind === "gemini" && cfg?.provider?.baseUrl ? cfg.provider.baseUrl : DEFAULT_BASE_URLS.gemini,
        model: "gemma-4-31b",
        modelPool: ["gemma-4-31b", "gemma-4-26b"],
      },
      maxTokens: 5,
      thinking: "off",
    };

    const res = await complete(env, classifierCfg, {
      system: INTENT_SYSTEM_PROMPT,
      parts: [{ type: "text", text: clean }],
    });

    const out = String(res?.text || "").trim().toUpperCase();
    const isYes = out.includes("YES");
    if (traceContext) {
      traceContext.intent = {
        requested: isYes,
        method: "gemma_classifier",
        model: res?.model || "gemma-4-31b",
        output: out.slice(0, 30),
      };
    }
    return isYes;
  } catch (err) {
    if (traceContext) {
      traceContext.intent = {
        requested: false,
        method: "gemma_classifier_error",
        error: String(err?.message ?? err).slice(0, 100),
      };
    }
    return false;
  }
}

/**
 * Determines whether a message should be answered with voice:
 * 1. If incoming message is an audio/voice note.
 * 2. If incoming text asks for a voice response (intent detected).
 */
async function shouldVoiceReply(env, msg, cfg, text, traceContext = null) {
  if (cfg?.voice?.enabled === false) {
    if (traceContext) traceContext.intent = { requested: false, reason: "voice disabled in config" };
    return false;
  }
  if (msg?.voice && cfg?.media?.audio?.enabled !== false) {
    if (traceContext) traceContext.intent = { requested: true, method: "incoming_voice", reason: "user sent voice note" };
    return true;
  }
  if (text) {
    return await detectVoiceIntent(env, text, cfg, traceContext);
  }
  return false;
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

/** One answer at a time per chat, bounded so an earlier slow request cannot starve waitUntil. */
function serialize(key, job) {
  const prev = jobs.get(key) ?? Promise.resolve();
  let timerId;
  const waitPrev = Promise.race([
    prev.catch(() => {}),
    new Promise((r) => { timerId = setTimeout(r, 12_000); }),
  ]).finally(() => clearTimeout(timerId));
  const next = waitPrev.then(job);
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
  const startedAt = Date.now();
  try {
    if (!msg?.from || msg.from.is_bot) return; // never answer bots
    if (!isSupportedChat(msg)) return;

    const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;
    const enabled = config_enabled(cfg);

    let answered = false;
    if (enabled) {
      if (msg.chat?.type === "private") {
        answered = true;
      } else {
        let id = null;
        let myBotUsername = null;
        try {
          id = await botId(env);
          myBotUsername = await botUsername(env);
        } catch {
          /* getMe failed: ignore, shouldAnswer will still check trigger word */
        }
        answered = shouldAnswer(msg, id, msg.chat?.type, myBotUsername);
      }
    }

    if (!enabled || !answered) {
      const ignoreReason = !enabled
        ? "bot disabled in admin panel"
        : "group message without wake word (سید) or reply to bot";
      await appendArchive(env, archiveRecord(msg, { answered: false, reason: ignoreReason })).catch(() => {});
      return;
    }

    await serialize(msg.chat.id, async () => {
      let outcome = null;
      let replyError = null;
      let tgOut = null;
      const trace = { intent: null, llm: null, voice: null, delivery: null };
      try {
        outcome = await reply(env, msg, cfg, trace);
        tgOut = outcome?.tgOut ?? "delivered";
      } catch (e) {
        replyError = e;
        if (e.trace && trace.llm) {
          trace.llm.attempts = e.trace;
        }
        const reason = String(e?.message ?? e);
        await bumpStats(env, { errors: 1, lastError: reason.slice(0, 300) });
        const text =
          e instanceof PoolExhausted
            ? exhaustedNotice(e.resetAt)
            : /\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(reason)
              ? RATE_LIMITED
              : ERRORS[Math.abs(hash(`${msg.chat.id}:${msg.message_id}`)) % ERRORS.length];
        try {
          await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, text, msg.message_id, msg.message_thread_id);
          tgOut = "error notice delivered to user";
        } catch (sendErr) {
          tgOut = `failed to send error notice: ${String(sendErr?.message ?? sendErr).slice(0, 120)}`;
        }
      } finally {
        const fullTrace = outcome?.trace || trace;
        logPipelineTrace(msg, outcome, replyError, fullTrace);

        await appendArchive(
          env,
          archiveRecord(msg, {
            answered: true,
            ok: !replyError,
            model: outcome?.model,
            reply: outcome?.text,
            error: replyError ? String(replyError.message ?? replyError) : null,
            ms: Date.now() - startedAt,
            reason: outcome?.reason,
            voice: outcome?.voice,
            voiceError: outcome?.voiceError,
            tgOut,
            trace: fullTrace,
          }),
        ).catch(() => {});
      }
    });
  } catch (outerErr) {
    console.error("processMessage fatal error:", outerErr);
  }
}

function logPipelineTrace(msg, outcome, replyError, trace) {
  const user = msg.from?.first_name || msg.from?.username || msg.from?.id || "user";
  const textSnippet = (msg.text || msg.caption || "").replace(/\s+/g, " ").slice(0, 50);
  console.log(`\n[Trace] 📨 Message from ${user} (Chat ${msg.chat?.id}): "${textSnippet}"`);
  if (trace?.intent) {
    const isV = trace.intent.requested ? "🎙️ Voice YES" : "💬 Voice NO";
    console.log(`  ├─ Intent: ${isV} [${trace.intent.method || "default"}] ${trace.intent.reason || ""}`);
  }
  if (trace?.llm?.attempts?.length) {
    console.log(`  ├─ LLM Routing:`);
    for (const a of trace.llm.attempts) {
      const icon = a.status === "ok" ? "✅" : "⚠️";
      const keyStr = a.keyIndex !== undefined ? ` Key #${a.keyIndex + 1}` : "";
      const msStr = a.ms !== undefined ? ` in ${a.ms}ms` : "";
      const errStr = a.error ? ` (${a.error.slice(0, 60)})` : "";
      console.log(`  │   ${icon} ${a.model}${keyStr} -> ${a.status}${msStr}${errStr}`);
    }
  }
  if (outcome?.model) {
    console.log(`  ├─ Selected Model: ${outcome.model}`);
  }
  if (trace?.voice) {
    const vIcon = trace.voice.status === "delivered" ? "✅" : "❌";
    console.log(`  ├─ Voice TTS: ${vIcon} ${trace.voice.status} ${trace.voice.chosenModel ? `[${trace.voice.chosenModel}]` : ""}`);
    if (trace.voice.attempts?.length) {
      for (const va of trace.voice.attempts) {
        console.log(`  │   ${va.ok ? "✅" : "❌"} ${va.model} -> ${va.ok ? "OK" : va.error} (${va.ms}ms)`);
      }
    }
  }
  if (replyError) {
    console.log(`  └─ ❌ Error: ${replyError.message || replyError}`);
  } else {
    console.log(`  └─ 📤 Telegram Out: ${outcome?.tgOut || "delivered"}`);
  }
}

const config_enabled = (cfg) => cfg.enabled !== false;

async function reply(env, msg, cfg, trace = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const text = msg.text || msg.caption || "";
  const myName = await botUsername(env).catch(() => null);
  const cmd = isCommand(text, myName);

  if (cmd === "ping") {
    await sendText(token, chatId, "🏓 pong", msg.message_id, threadId);
    return { text: "🏓 pong", reason: "command /ping", tgOut: "text delivered" };
  }
  if (cmd === "start" || cmd === "help") {
    const helpMsg = HELP.replace("__MODE__", MODE_NAME[cfg.mode] ?? "Know-it-all");
    await sendText(token, chatId, helpMsg, msg.message_id, threadId);
    return { text: helpMsg, reason: `command /${cmd}`, tgOut: "text delivered" };
  }

  // Checked before the typing indicator and before any model call, so an exhausted day
  // costs no quota and does not look like a hang.
  if (await overDailyCap(env, cfg, msg)) {
    return { text: DAILY_LIMIT, reason: "daily cap reached", tgOut: "daily cap guard" };
  }

  const isVoice = await shouldVoiceReply(env, msg, cfg, text, trace);
  const actionKind = isVoice ? "upload_voice" : "typing";

  await sendChatAction(token, chatId, actionKind, threadId).catch(() => {});
  await bumpStats(env, { requests: 1, lastUsed: new Date().toISOString() });

  const typingHeartbeat = setInterval(() => {
    sendChatAction(token, chatId, actionKind, threadId).catch(() => {});
  }, 4000);

  let answer, usedModel;
  trace.llm = { attempts: [], chosenModel: null };
  try {
    const id = msg.reply_to_message ? await botId(env).catch(() => null) : null;
    const { media, note } = await collectMedia(env, msg, cfg);
    const { text: replyText, fromBot } = replyContext(msg, id);

    const res = await complete(env, cfg, {
      system: buildSystemPrompt(cfg, { isVoice }),
      parts: buildUserContent({ text, replyText, replyFromBot: fromBot, media, note }),
      maxTokens: cfg.maxTokens,
    });
    answer = res.text;
    usedModel = res.model;
    if (res.trace) trace.llm.attempts = res.trace;
    trace.llm.chosenModel = usedModel;
  } finally {
    clearInterval(typingHeartbeat);
  }

  // A voice note (or text requesting voice) deserves a voice back: the text answer above
  // becomes a Live API turn and comes back as audio.
  if (isVoice) {
    trace.voice = { attempts: [], status: "pending" };
    const startAt = Date.now();
    const elapsed = () => Date.now() - startAt;
    const keep = setInterval(() => sendChatAction(token, chatId, "upload_voice", threadId).catch(() => {}), 4000);
    let audioSent = false;
    let vErrText = null;
    try {
      if (elapsed() > VOICE_BUDGET_MS) throw new Error("live voice: over the time budget");
      const wav = await speak(env, cfg, answer, {
        timeoutMs: Math.max(3000, VOICE_BUDGET_MS - elapsed()),
        onTrace: (t) => {
          trace.voice.attempts = t.attempts || [];
          if (t.chosenModel) trace.voice.chosenModel = t.chosenModel;
        },
      });
      await sendAudioFile(token, chatId, wav, "sayyad.wav", "audio/wav", msg.message_id, threadId);
      audioSent = true;
      trace.voice.status = "delivered";
      trace.delivery = { kind: "voice", filename: "sayyad.wav" };
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel, voice: true, tgOut: "audio delivered (sayyad.wav)", trace };
    } catch (voiceErr) {
      vErrText = `voice failed: ${voiceErr?.message ?? voiceErr}`.slice(0, 300);
      trace.voice.status = "failed";
      trace.voice.error = vErrText;
      await bumpStats(env, { errors: 1, lastError: vErrText });
    } finally {
      clearInterval(keep);
    }
    if (!audioSent) {
      await sendLong(token, chatId, answer, msg.message_id, { model: usedModel, message_thread_id: threadId });
      trace.delivery = { kind: "text_fallback", reason: vErrText };
      await bumpStats(env, { replies: 1 });
      return { text: answer, model: usedModel, voice: false, voiceError: vErrText, tgOut: "text fallback delivered", trace };
    }
  }

  await sendLong(token, chatId, answer, msg.message_id, { model: usedModel, message_thread_id: threadId });
  trace.delivery = { kind: "text" };
  await bumpStats(env, { replies: 1 });
  return { text: answer, model: usedModel, tgOut: "text delivered", trace };
}

/** Voice notes are answered with voice — unless either switch (input or voice) is off. */
const voiceReply = (msg, cfg) =>
  !!msg?.voice && cfg?.media?.audio?.enabled !== false && cfg?.voice?.enabled !== false;

/** Refuse politely once the daily budget is gone, and never call the model. */
async function overDailyCap(env, cfg, msg) {
  if (!(cfg.dailyCap > 0)) return false;
  if (usedToday(await loadStats(env)) < cfg.dailyCap) return false;

  const last = capNotified.get(msg.chat.id) ?? 0;
  if (Date.now() - last < 60_000) return true;
  capNotified.set(msg.chat.id, Date.now());
  if (capNotified.size > 1000) {
    const now = Date.now();
    for (const [k, v] of capNotified) {
      if (now - v >= 60_000) capNotified.delete(k);
    }
  }
  try {
    await sendText(env.TELEGRAM_BOT_TOKEN, msg.chat.id, DAILY_LIMIT, msg.message_id, msg.message_thread_id);
  } catch {
    /* the guard still works even if the notice does not get through */
  }
  return true;
}

// ------------------------------ src/tools.js ------------------------------
// Operator routes: /diag (is anything broken?) and /setup (point Telegram here).








/** A live probe of both the Telegram side and the configured model. */
async function diagnostics(env = {}) {
  const out = { provider: null, model: null, checks: {} };

  if (!env?.TELEGRAM_BOT_TOKEN) {
    out.checks.telegram = "TELEGRAM_BOT_TOKEN secret is missing";
  } else {
    try {
      const me = await getMe(env.TELEGRAM_BOT_TOKEN);
      out.checks.telegram = { ok: !!me?.ok, username: me?.result?.username, error: me?.description };
      const wh = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN);
      out.checks.webhook = {
        url: wh?.result?.url,
        pending: wh?.result?.pending_update_count,
        lastError: wh?.result?.last_error_message,
      };
    } catch (e) {
      out.checks.telegram = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }
  }

  const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;
  out.provider = cfg.provider.kind;
  out.model = cfg.provider.model;
  out.endpoint =
    cfg.provider.kind === "gemini"
      ? `${cfg.provider.baseUrl}/models/${cfg.provider.model}:generateContent`
      : `${cfg.provider.baseUrl}/chat/completions`;

  out.checks.credentials = {
    gemini: extractKeys(env).length > 0 || env?.GEMINI_API_KEY ? "set" : "missing",
    openai: env?.API_KEY || env?.OPENROUTER_API_KEY ? "set" : "missing",
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

  if (env?.DIAG_IMAGE) {
    try {
      // Brief pause so consecutive subrequests do not trip the tight RPM limit or socket reset
      await new Promise((r) => setTimeout(r, 600));
      const isTiny1x1 = typeof env.DIAG_IMAGE === "string" && env.DIAG_IMAGE.includes("AAAAEAAAAB");
      const testImg =
        typeof env.DIAG_IMAGE === "string" && env.DIAG_IMAGE.length > 100 && !isTiny1x1
          ? env.DIAG_IMAGE
          : "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNwa9pCEmIY1TCqYfhqAACXG3wQdHVYSAAAAABJRU5ErkJggg==";
      const diagCfg = { ...cfg, thinking: "off" };
      const rImg = await complete(env, diagCfg, {
        system: "You are Sayyad. Answer with one short Persian word.",
        parts: [
          { type: "image", mime: "image/png", data: testImg },
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
    const contentLength = Number(req.headers.get("content-length"));
    if (contentLength && contentLength > 2 * 1024 * 1024) {
      return new Response("Payload Too Large", { status: 413 });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && req.method === "POST") return webhook(req, env, ctx);

    if (path === "/") return json({ ok: true, bot: "sayyad" });

    if (path === "/setup") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
      return json(await setup(req, env, url).catch((e) => ({ error: String(e?.message ?? e) })));
    }
    if (path === "/setup/reset") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
      return json(await resetWebhook(env).catch((e) => ({ error: String(e?.message ?? e) })));
    }

    if (path === "/diag") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
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

  // Strictly require secret token when ADMIN_PASSWORD is configured
  if (env.ADMIN_PASSWORD) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (!got) {
      return new Response("forbidden", { status: 403 });
    }
    const want = await signWebhookSecret(env.ADMIN_PASSWORD);
    if (!timingSafeEqual(got, want)) {
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

// ------------------------------ src/nodeStore.js ------------------------------
// File-based KV storage for Node.js environments.
// Matches Cloudflare KV API (get, put, delete) with zero external dependencies.




class FileKV {
  constructor(dir = "./data", filename = "store.json") {
    this.dir = dir;
    this.filePath = join(dir, filename);
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw) || {};
      } else if (existsSync(`${this.filePath}.tmp`)) {
        const raw = readFileSync(`${this.filePath}.tmp`, "utf-8");
        this.data = JSON.parse(raw) || {};
      }
    } catch {
      this.data = {};
    }
  }

  save() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error("FileKV save failed:", err?.message || err);
    }
  }

  async get(key, type = "text") {
    const val = this.data[key];
    if (val === undefined || val === null) return null;
    if (type === "json") {
      try {
        return typeof val === "string" ? JSON.parse(val) : val;
      } catch {
        return null;
      }
    }
    return typeof val === "string" ? val : JSON.stringify(val);
  }

  async put(key, value) {
    this.data[key] = typeof value === "string" ? value : JSON.stringify(value);
    this.save();
  }

  async delete(key) {
    if (key in this.data) {
      delete this.data[key];
      this.save();
    }
  }
}

export { ARCHIVE_KEY, ARCHIVE_LIMIT, ApiError, BASE_RULES, CONFIG_KEY, COOKIE, DEFAULT_BACKOFF, DEFAULT_BASE_URLS, DEFAULT_MODEL, DEFAULT_MODEL_POOL, DEFAULT_PERSONAS, DailyQuotaError, FALLBACK_VOICE_MODELS, FileKV, LEGACY_CONFIG_KEY, LEGACY_STATS_KEY, MODES, MODE_LABELS, MULTIMODAL_MODELS, MinuteQuotaError, NodeWebSocket, PACIFIC_OFFSET_MS, PoolExhausted, QUOTA_KEY, REPLY_TEXT_LIMIT, SAFETY_CATEGORIES, SAFETY_CATEGORY_KEYS, SAFETY_LEVELS, SCHEMA_VERSION, STATS_KEY, TEXT_EXTENDED_MODELS, THINKING_BUDGETS, THINKING_LEVELS, TRIGGER, UnknownModelError, VOICE_POSITIVE_RE, acquireKey, acquireKeyWithWait, appendArchive, archiveRecord, botId, botUsername, buildGeminiBody, buildSystemPrompt, buildUserContent, bumpStats, callJson, clampInt, clearKeyPoolCache, clearMinuteQuota, collectMedia, complete, completeGemini, completeOpenAI, defaultConfig, deleteWebhook, detectMedia, detectVoiceIntent, diagnostics, downloadFile, endpointOf, esc, extractKeys, failedLoginAttempts, getKeyPool, getKeyPoolStatus, getMe, getWebhookInfo, handleAdmin, hasMediaPayload, isAuthed, isCommand, isCredentialError, isMultimodalModel, isRtlText, isShapeError, isSupportedChat, isTransient, json, loadConfig, loadQuota, loadStats, mapModelForProvider, mdToHtml, mdToRichHtml, mediaKind, migrateLegacy, minuteQuota, nextPacificMidnight, normalizeConfig, normalizeFa, normalizePool, pcmToWav, poolResumeTime, preview, processMessage, providerFor, quotaKind, readArchive, readGeminiText, readPatch, recordFailedLogin, renderBlockquotes, renderDashboard, renderLogin, renderMarkdownTables, replyContext, reportPage, resetLoginRateLimit, resetWebhook, safetySettings, saveConfig, saveQuota, saveState, sendAudioFile, sendChatAction, sendLong, sendRichMessage, sendText, serialize, setLiveTimeout, setStateFilePath, setWebhook, setup, shouldAnswer, shouldVoiceReply, signSecret, signWebhookSecret, speak, splitText, spokenText, tg, thinkingConfig, timingSafeEqual, toBase64, toGeminiPart, toOpenAIPart, todayKey, truncate, usedToday, verifyPassword, voiceReply };
