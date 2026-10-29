import { ApiError, isCredentialError } from "./http.js";
import { acquireKey, acquireKeyWithWait, clearKeyPoolCache, extractKeys, getKeyPool } from "./keyPool.js";
import { DailyQuotaError, MinuteQuotaError, UnknownModelError, completeGemini } from "./providerGemini.js";
import { completeOpenAI } from "./providerOpenai.js";
import { DEFAULT_BASE_URLS, MULTIMODAL_MODELS, loadQuota, nextPacificMidnight, poolResumeTime, saveQuota } from "./store.js";

const PROVIDERS = { gemini: completeGemini, openai: completeOpenAI };

/** In-memory parking for per-minute rate limits (RPM/TPM). Costs 0 KV writes. */
export const minuteQuota = new Map();

export function clearMinuteQuota() {
  minuteQuota.clear();
  clearKeyPoolCache();
}

export function providerFor(cfg) {
  const impl = PROVIDERS[cfg.provider?.kind];
  if (!impl) throw new ApiError(`unknown provider "${cfg.provider?.kind}"`, 500);
  return impl;
}

/** Check if payload contains visual or audio media. */
export function hasMediaPayload(payload) {
  return Array.isArray(payload?.parts) && payload.parts.some((p) => p && (p.type === "image" || p.type === "video" || p.type === "audio"));
}

/** Check if model name supports multimodal input. */
export function isMultimodalModel(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("gemma") || m === "antigravity") return false;
  return m.startsWith("gemini") || (Array.isArray(MULTIMODAL_MODELS) && MULTIMODAL_MODELS.includes(model));
}

/** Map model names when falling back across providers. */
export function mapModelForProvider(model, targetKind, baseUrl = "") {
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
export function endpointOf(cfg, model = cfg.provider.model) {
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
        e.keyIndex = keyHandle.index;
        e.model = model;
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
        if (/timeout|aborted|network error|econnreset|etimedout|socket hang up|eai_again|fetch failed/i.test(e?.message)) {
          trace.push({ model, keyIndex: keyHandle.index, status: "network_timeout", error: e?.message, ms });
          continue;
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
    if (last?.keyIndex !== undefined) err.keyIndex = last.keyIndex;
    if (last?.model) err.model = last.model;
    if (last?.url) err.url = last.url;
    if (last?.status !== undefined) err.status = last.status;
    if (last?.details) err.details = last.details;
    throw err;
  }
  const err = last ?? new PoolExhausted(fallbackReset, "no model available");
  err.trace = trace;
  if (last?.keyIndex !== undefined) err.keyIndex = last.keyIndex;
  if (last?.model) err.model = last.model;
  if (last?.url) err.url = last.url;
  if (last?.status !== undefined) err.status = last.status;
  if (last?.details) err.details = last.details;
  throw err;
}

/** Every model in the pool is spent until `resetAt`. Carries the exact hour it frees up. */
export class PoolExhausted extends ApiError {
  constructor(resetAt, detail) {
    super(`model pool exhausted until ${new Date(resetAt).toISOString()}${detail ? `: ${detail}` : ""}`, 429);
    this.name = "PoolExhausted";
    this.resetAt = resetAt;
  }
}

export async function complete(env, cfg, payload) {
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
