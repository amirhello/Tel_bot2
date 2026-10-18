// Gemini's native API — the only path that accepts video and audio.
//
// Wire format: { inlineData: { mimeType, data } } under
// POST {baseUrl}/models/{model}:generateContent

import { ApiError, callJson, isShapeError, isTransient } from "./http.js";
import { SAFETY_CATEGORIES, nextPacificMidnight } from "./store.js";

/** This model's daily quota is spent. Distinct from a per-minute 429: waiting does not help. */
export class DailyQuotaError extends ApiError {
  constructor(model, message) {
    super(message, 429);
    this.name = "DailyQuotaError";
    this.model = model;
    this.resetAt = nextPacificMidnight();
  }
}

/** This model's per-minute quota is spent (RPM/TPM). Parked for 60 seconds. */
export class MinuteQuotaError extends ApiError {
  constructor(model, message, resetAt = Date.now() + 60_000) {
    super(message, 429);
    this.name = "MinuteQuotaError";
    this.model = model;
    this.resetAt = resetAt;
  }
}

/** The provider does not know this model name. Never worth trying again today. */
export class UnknownModelError extends ApiError {
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
export function quotaKind(message) {
  const m = String(message ?? "").toLowerCase();
  if (/(?:^|[^a-z])(day|daily|rpd|24\s*h)(?:[^a-z]|$)/i.test(m)) return "day";
  if (/(?:^|[^a-z])(minute|min|rpm|tpm)(?:[^a-z]|$)/i.test(m)) return "minute";
  return "other";
}

/** Neutral part -> Gemini part. Everything binary becomes inlineData. */
export function toGeminiPart(part) {
  if (part.type === "text") return { text: part.text };
  if (part.type === "image" || part.type === "video" || part.type === "audio") {
    return { inlineData: { mimeType: part.mime, data: part.data } };
  }
  return null;
}

export const THINKING_BUDGETS = {
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
export function thinkingConfig(cfg) {
  if (!cfg?.thinking) return {};
  const budget = THINKING_BUDGETS[cfg.thinking] !== undefined ? THINKING_BUDGETS[cfg.thinking] : 4096;
  return { thinkingConfig: { thinkingBudget: budget } };
}

export function safetySettings(cfg) {
  return Object.entries(SAFETY_CATEGORIES).map(([key, category]) => ({
    category,
    threshold: cfg.safety?.[key] ?? "BLOCK_NONE",
  }));
}

export function buildGeminiBody(cfg, { system, parts, maxTokens }, shape = {}) {
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
export function readGeminiText(data) {
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

export async function completeGemini(env, cfg, { system, parts, maxTokens }) {
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
