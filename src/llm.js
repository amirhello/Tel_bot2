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
  let last;

  for (const model of pool) {
    if ((quota[model] ?? 0) > now) continue;
    if ((minuteQuota.get(model) ?? 0) > now) continue;

    const poolKeys = getKeyPool(env);
    const usableKeys = poolKeys.filter((k) => !k.disabled);
    const totalUsableKeys = Math.max(1, usableKeys.length);

    let modelDailyFailures = 0;
    let modelMinuteFailures = 0;
    let lastModelQuotaError = null;
    let attemptsOnModel = 0;

    while (attemptsOnModel < totalUsableKeys) {
      attemptsOnModel++;
      const keyHandle = await acquireKeyWithWait(env, { model, maxWaitMs: 0 });
      if (!keyHandle) {
        break; // No available key for this model
      }

      const apiKey = keyHandle.key;

      try {
        const use = { ...cfg, apiKey, provider: { ...cfg.provider, model } };
        const r = await completeGemini(env, use, payload);
        keyHandle.release();
        if (dirty.size) await saveQuota(env, quota);
        return { ...r, model };
      } catch (e) {
        last = e;
        lastModelQuotaError = e;
        keyHandle.release(e);

        if (e instanceof DailyQuotaError) {
          modelDailyFailures++;
          continue; // Try next key for this model
        }
        if (e instanceof MinuteQuotaError) {
          modelMinuteFailures++;
          continue; // Try next key for this model
        }
        if (e instanceof UnknownModelError) {
          quota[e.model] = nextPacificMidnight();
          dirty.add(e.model);
          break; // A 404 model name cannot succeed with any key
        }
        if (/quota|resource_exhausted|high demand|spikes in demand|overloaded|temporarily unavailable/i.test(e?.message)) {
          modelMinuteFailures++;
          continue;
        }
        throw e;
      }
    }

    // FIX BUG-01: Only park the model globally if ALL keys in the pool fail on that model
    const currentPool = getKeyPool(env);
    const currentUsable = currentPool.filter((k) => !k.disabled);
    const allKeysDailyExhausted =
      currentUsable.length > 0 &&
      currentUsable.every((k) => (k.rpdCooldownUntil > now) || (k.modelRpdCooldown?.[model] > now));
    const allKeysMinuteExhausted =
      currentUsable.length > 0 &&
      currentUsable.every(
        (k) =>
          (k.rpmCooldownUntil > now) ||
          (k.modelRpmCooldown?.[model] > now) ||
          (k.highDemandCooldownUntil > now) ||
          (k.rpdCooldownUntil > now) ||
          (k.modelRpdCooldown?.[model] > now),
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

  const anyParked = pool.some((m) => (quota[m] ?? 0) > now || (minuteQuota.get(m) ?? 0) > now);
  if (last instanceof DailyQuotaError || last instanceof MinuteQuotaError || anyParked) {
    const unparkTimes = pool.map((m) => Math.max(quota[m] ?? 0, minuteQuota.get(m) ?? 0)).filter((t) => t > now);
    const resumeAt = unparkTimes.length ? Math.min(...unparkTimes) : poolResumeTime(quota, pool);
    throw new PoolExhausted(resumeAt, last?.message);
  }
  throw last ?? new PoolExhausted(nextPacificMidnight(), "no model available");
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
      return completeOpenAI(env, { ...cfg, provider: { ...cfg.provider, kind: "openai", model, baseUrl } }, payload);
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
      return await providerFor(use)(env, use, payload);
    } catch (e) {
      last = e;
      if (!isCredentialError(e)) throw e;
    }
  }
  throw last;
}
