// Multi-key pool manager for Google Gemini API keys.
// Provides Round-Robin load balancing, per-key concurrency locking (one in-flight request per key),
// RPM/RPD cooldown tracking, dead key isolation, and JSON file persistence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let roundRobinIndex = 0;
let keyPoolCache = null;
let stateFilePath = null;

function getStatePath() {
  if (stateFilePath) return stateFilePath;
  try {
    const cwd = typeof process !== "undefined" && process.cwd ? process.cwd() : ".";
    return join(cwd, "data", "keys-state.json");
  } catch {
    return "keys-state.json";
  }
}

export function setStateFilePath(path) {
  stateFilePath = path;
}

/** Extract list of raw keys from environment or config. */
export function extractKeys(env) {
  if (env && ("GEMINI_API_KEYS" in env || "GEMINI_API_KEY" in env)) {
    const raw = env.GEMINI_API_KEYS || env.GEMINI_API_KEY;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((k) => String(k).trim()).filter((k) => k.length >= 3);
    return String(raw).split(/[\r\n,]+/).map((k) => k.trim()).filter((k) => k.length >= 3);
  }

  const procRaw = typeof process !== "undefined" ? (process.env?.GEMINI_API_KEYS || process.env?.GEMINI_API_KEY) : undefined;
  if (procRaw) {
    if (Array.isArray(procRaw)) return procRaw.map((k) => String(k).trim()).filter((k) => k.length >= 3);
    return String(procRaw).split(/[\r\n,]+/).map((k) => k.trim()).filter((k) => k.length >= 3);
  }
  return [];
}

/** Load or initialize the persistent state of all keys. */
function loadState(keys) {
  let saved = {};
  const filePath = getStatePath();
  try {
    if (existsSync(filePath)) {
      saved = JSON.parse(readFileSync(filePath, "utf-8")) || {};
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
      highDemandCooldownUntil: s.highDemandCooldownUntil && s.highDemandCooldownUntil > now ? s.highDemandCooldownUntil : 0,
      disabled: Boolean(s.disabled),
      lastError: s.lastError || null,
    };
  });
}

/** Persist state to local JSON file safely. */
export function saveState(pool) {
  const filePath = getStatePath();
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const obj = {};
    for (const item of pool) {
      obj[item.key] = {
        lastUsed: item.lastUsed,
        requestsToday: item.requestsToday,
        lastResetDay: item.lastResetDay,
        rpmCooldownUntil: item.rpmCooldownUntil,
        rpdCooldownUntil: item.rpdCooldownUntil,
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
export function getKeyPool(env) {
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
export function clearKeyPoolCache() {
  keyPoolCache = null;
  roundRobinIndex = 0;
}

/**
 * Acquire the next available key using Round-Robin, enforcing concurrency lock (inUse)
 * and skipping cooling/disabled keys.
 */
export function acquireKey(env, opts = {}) {
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
    }
  }

  const count = pool.length;
  for (let step = 0; step < count; step++) {
    const idx = (roundRobinIndex + step) % count;
    const item = pool[idx];

    if (item.disabled) continue;
    if (item.inUse) continue; // One concurrent request per key rule
    if (item.rpmCooldownUntil > now) continue;
    if (item.rpdCooldownUntil > now) continue;
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
      if (err) recordKeyError(item, err);
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

/** Classify error and apply proper cooldown or quarantine. */
function recordKeyError(item, err) {
  const now = Date.now();
  const msg = String(err?.message ?? err);
  const status = Number(err?.status ?? 0);
  item.lastError = msg.slice(0, 300);

  // 1. Invalid or revoked API key -> permanently disable
  if (status === 400 && /API_KEY_INVALID|key.*invalid|unregistered callers|API key not valid/i.test(msg)) {
    item.disabled = true;
    return;
  }
  if (status === 403 && /forbidden|not authorized|permission/i.test(msg)) {
    item.disabled = true;
    return;
  }

  // 2. Safety filter block -> Key is healthy! Do NOT penalize key
  if (/blocked.*safety|prompt_blocked|finishReason.*safety/i.test(msg)) {
    return;
  }

  // 3. Daily quota exhaustion -> 24 hours cooldown
  if (
    (status === 429 || status === 503) &&
    (/per.?day|daily|requests_per_day/i.test(msg) || err?.name === "DailyQuotaError")
  ) {
    item.rpdCooldownUntil = now + 24 * 3600_000;
    return;
  }

  // 4. Minute RPM rate limit -> 60 seconds cooldown
  if (
    status === 429 ||
    err?.name === "MinuteQuotaError" ||
    /resource_exhausted|quota exceeded|too many requests|rate.?limit/i.test(msg)
  ) {
    item.rpmCooldownUntil = now + 60_000;
    return;
  }

  // 5. Server high demand / overload -> 30 seconds cooldown
  if (status === 503 || /high demand|spikes in demand|overloaded/i.test(msg)) {
    item.highDemandCooldownUntil = now + 30_000;
  }
}

/** Diagnostic overview of all keys in pool for admin dashboard. */
export function getKeyPoolStatus(env) {
  const pool = getKeyPool(env);
  const now = Date.now();

  return pool.map((item) => {
    let status = "active";
    let detail = "Ready";

    if (item.disabled) {
      status = "invalid";
      detail = "Disabled / Invalid";
    } else if (item.rpdCooldownUntil > now) {
      status = "daily_quota";
      const hoursLeft = Math.ceil((item.rpdCooldownUntil - now) / 3600_000);
      detail = `Daily quota reached (~${hoursLeft}h left)`;
    } else if (item.rpmCooldownUntil > now) {
      status = "rpm_cooldown";
      const secsLeft = Math.ceil((item.rpmCooldownUntil - now) / 1000);
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
