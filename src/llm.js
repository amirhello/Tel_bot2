// Provider dispatcher. Picks the configured backend, walks a Gemini model pool when the
// daily quota runs out, and falls back to the other provider when a key is missing.
//
// The rest of the bot never sees a provider-specific wire format: it hands over neutral
// parts and gets back plain text.

import { ApiError, isCredentialError } from "./http.js";
import { DailyQuotaError, MinuteQuotaError, UnknownModelError, completeGemini } from "./providerGemini.js";
import { completeOpenAI } from "./providerOpenai.js";
import { DEFAULT_BASE_URLS, loadQuota, nextPacificMidnight, poolResumeTime, saveQuota } from "./store.js";

const PROVIDERS = { gemini: completeGemini, openai: completeOpenAI };

/** In-memory parking for per-minute rate limits (RPM/TPM). Costs 0 KV writes. */
export const minuteQuota = new Map();

export function clearMinuteQuota() {
  minuteQuota.clear();
}

export function providerFor(cfg) {
  const impl = PROVIDERS[cfg.provider?.kind];
  if (!impl) throw new ApiError(`unknown provider "${cfg.provider?.kind}"`, 500);
  return impl;
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
