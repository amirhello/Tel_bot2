// Everything that touches the KV namespace: config, stats and migration.

export const SCHEMA_VERSION = 3;

export const CONFIG_KEY = "config:v2";
export const STATS_KEY = "stats:v2";
export const QUOTA_KEY = "quota:v1";
export const LEGACY_CONFIG_KEY = "config:v1";
export const LEGACY_STATS_KEY = "stats:v1";

/** Google's daily quota resets at midnight Pacific. We park a model until then. */
export const PACIFIC_OFFSET_MS = -8 * 3600 * 1000;

export function nextPacificMidnight(now = Date.now()) {
  const shifted = now + PACIFIC_OFFSET_MS;
  const startOfDay = Math.floor(shifted / 86400000) * 86400000;
  return startOfDay + 86400000 - PACIFIC_OFFSET_MS;
}

/**
 * Tried strongest-first. Names are provider-specific: if one is wrong the provider
 * answers 404 and the model is parked for a day instead of being retried forever.
 */
export const DEFAULT_MODEL_POOL = [
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

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
export const SAFETY_LEVELS = ["BLOCK_NONE", "BLOCK_ONLY_HIGH", "BLOCK_MEDIUM_AND_ABOVE", "BLOCK_LOW_AND_ABOVE", "OFF"];

export const SAFETY_CATEGORIES = {
  harassment: "HARM_CATEGORY_HARASSMENT",
  hateSpeech: "HARM_CATEGORY_HATE_SPEECH",
  sexuallyExplicit: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  dangerous: "HARM_CATEGORY_DANGEROUS_CONTENT",
};

export const SAFETY_CATEGORY_KEYS = Object.keys(SAFETY_CATEGORIES);

export const DEFAULT_BASE_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://openrouter.ai/api/v1",
};

export function defaultConfig(personas) {
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
export function normalizeConfig(saved, personas) {
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
export function normalizePool(value, primary) {
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
export function migrateLegacy(legacy, legacyStats, personas) {
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

export async function loadConfig(env, personas) {
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

export async function saveConfig(env, config) {
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

export const todayKey = () => new Date().toISOString().slice(0, 10);

export function usedToday(stats, day = todayKey()) {
  return stats?.day === day ? stats?.today ?? 0 : 0;
}

export async function loadStats(env) {
  return normalizeStats(await readKey(env, STATS_KEY));
}

/* ------------------------------------------------------------------ per-model quota parking */

/**
 * { "<model>": <epoch ms when it becomes available again> }. A model is "parked" while its
 * daily quota is spent; the entry expires on its own, so no cleanup job is needed.
 */
export async function loadQuota(env) {
  const raw = await readKey(env, QUOTA_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export async function saveQuota(env, quota) {
  try {
    await writeKey(env, QUOTA_KEY, quota);
  } catch {
    /* if we cannot remember, we simply re-try the model tomorrow */
  }
}

/** When the last parked model in the pool frees up, the bot can answer again. */
export function poolResumeTime(quota, pool) {
  const now = Date.now();
  const active = pool.filter((m) => (quota[m] ?? 0) > now);
  if (active.length < pool.length) return now;
  const times = pool.map((m) => quota[m] ?? 0).filter(Boolean);
  return times.length ? Math.max(...times) : now;
}

export async function bumpStats(env, patch) {
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