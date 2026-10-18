// Multi-key pool manager for Google Gemini API keys.
// Provides Round-Robin load balancing, per-key concurrency locking (one in-flight request per key),
// RPM/RPD cooldown tracking, dead key isolation, and JSON file persistence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let roundRobinIndex = 0;
let keyPoolCache = null;
let stateFilePath = null;

function getStatePath() {
  return stateFilePath;
}

export function setStateFilePath(path) {
  stateFilePath = path;
}

function cleanKey(item) {
  if (!item || typeof item !== "string") return "";
  return item.replace(/^[\s\{\}\[\]"'`]+|[\s\{\}\[\]"'`]+$/g, "").trim();
}

/** Extract list of raw keys from environment or config. */
export function extractKeys(env) {
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
export function saveState(pool) {
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
      item.modelRpdCooldown = {};
      item.modelRpmCooldown = {};
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
export async function acquireKeyWithWait(env, opts = {}) {
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
        earliestAvailable = Math.min(earliestAvailable, now + 500);
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
  const msg = String(err?.message ?? err);
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

  // 3. Daily quota exhaustion -> 24 hours cooldown for model or key
  if (
    (status === 429 || status === 503) &&
    (/per.?day|daily|requests_per_day/i.test(msg) || err?.name === "DailyQuotaError")
  ) {
    const model = err?.model || reqModel;
    if (model) {
      if (!item.modelRpdCooldown) item.modelRpdCooldown = {};
      item.modelRpdCooldown[model] = now + 24 * 3600_000;
    } else {
      item.rpdCooldownUntil = now + 24 * 3600_000;
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
export function getKeyPoolStatus(env) {
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
