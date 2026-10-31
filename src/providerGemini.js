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
  low: 2000,
  medium: 4096,
  high: 8192,
};

/**
 * thinkingConfig. Google Gemini REST API expects thinkingConfig.thinkingBudget (integer token count:
 * minimal: 1024, low: 2000, medium: 4096, high: 8192, off: 0).
 */
export function thinkingConfig(cfg) {
  if (cfg?.thinking === "off") return { thinkingConfig: { thinkingBudget: 0 } };
  if (typeof cfg?.thinkingBudget === "number") {
    return { thinkingConfig: { thinkingBudget: cfg.thinkingBudget } };
  }
  if (!cfg?.thinking) return {};
  const budget = THINKING_BUDGETS[cfg.thinking] !== undefined ? THINKING_BUDGETS[cfg.thinking] : 2000;
  return { thinkingConfig: { thinkingBudget: budget } };
}

export const SEARCH_GROUNDING_MODELS = [
  "antigravity",
  "antigravity-preview-09-2026",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

export function isSearchSupported(model) {
  const m = String(model || "").toLowerCase();
  return SEARCH_GROUNDING_MODELS.some((sm) => m.includes(sm.toLowerCase()));
}

export function isAntigravity(model) {
  return String(model || "").toLowerCase().includes("antigravity");
}

export function safetySettings(cfg) {
  return Object.entries(SAFETY_CATEGORIES).map(([key, category]) => ({
    category,
    threshold: cfg.safety?.[key] ?? "BLOCK_NONE",
  }));
}

export function buildGeminiBody(cfg, { system, parts, maxTokens, search }, shape = {}) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: parts.map(toGeminiPart).filter(Boolean) }],
    generationConfig: { maxOutputTokens: maxTokens, ...thinkingConfig(cfg) },
  };
  if (!shape.noThinking) body.generationConfig = { ...body.generationConfig, ...thinkingConfig(cfg) };
  else delete body.generationConfig.thinkingConfig;
  if (!shape.noSafety) body.safetySettings = safetySettings(cfg);

  const model = cfg?.provider?.model;
  const wantSearch = (search || cfg?.search) && !shape.noTools && isSearchSupported(model);
  if (wantSearch) {
    body.tools = [{ googleSearch: {} }];
    delete body.generationConfig.thinkingConfig;
  }

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

/** Extract search queries and source citations from Google Search Grounding metadata. */
export function readGeminiSources(data) {
  const grounding = data?.candidates?.[0]?.groundingMetadata;
  if (!grounding) return { queries: [], sources: [] };
  const queries = Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries : [];
  const rawChunks = Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : [];
  const sources = [];
  const seen = new Set();
  for (const c of rawChunks) {
    const uri = c?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    let title = c?.web?.title;
    if (!title) {
      try {
        title = new URL(uri).hostname.replace(/^www\./, "");
      } catch {
        title = "منبع وب";
      }
    }
    sources.push({ title, url: uri });
  }
  return { queries, sources: sources.slice(0, 5) };
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
function shapes(cfg, search) {
  const list = [{}];
  if (search || cfg?.search) list.push({ noTools: true });
  if (cfg?.thinking) list.push({ noThinking: true });
  list.push({ noTools: true, noThinking: true, noSafety: true });
  return list;
}

/** Extract answer text, search queries and source citations from Antigravity Interactions response. */
export function parseAntigravityResponse(data, model = "Antigravity") {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  let text = typeof data?.output_text === "string" ? data.output_text : "";
  const queries = [];
  const sources = [];
  const seen = new Set();

  for (const step of steps) {
    if (step.type === "google_search_call" && Array.isArray(step.arguments?.queries)) {
      queries.push(...step.arguments.queries);
    }
    if (step.type === "model_output" && Array.isArray(step.content)) {
      for (const block of step.content) {
        if (block.type === "text" && block.text) {
          if (!text) text += block.text;
          else if (!text.includes(block.text)) text += "\n" + block.text;
        }
        if (Array.isArray(block.annotations)) {
          for (const ann of block.annotations) {
            if (ann.type === "url_citation" && ann.url && !seen.has(ann.url)) {
              seen.add(ann.url);
              sources.push({ title: ann.title || "منبع وب", url: ann.url });
            }
          }
        }
      }
    }
  }

  return { text: text.trim(), queries, sources: sources.slice(0, 5), model };
}

export async function completeAntigravity(env, cfg, { system, parts }) {
  const apiKey = cfg?.apiKey || env.GEMINI_API_KEY;
  if (!apiKey) throw new ApiError("GEMINI_API_KEY secret is not set", 500);

  const url = `${cfg.provider.baseUrl}/interactions`;
  const textParts = (parts || []).filter((p) => p && p.type === "text").map((p) => p.text).join("\n");
  const fullInput = system ? `${system}\n\n${textParts}` : textParts;

  const payload = {
    agent: "antigravity-preview-09-2026",
    input: fullInput,
    tools: [
      { type: "google_search" },
      { type: "url_context" },
    ],
  };

  const data = await callJson(url, {
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: payload,
    retryOn: retryableForGemini,
  });

  const parsed = parseAntigravityResponse(data, cfg.provider?.model || "Antigravity");
  if (!parsed.text) throw new ApiError("Antigravity returned no text", 200);
  return parsed;
}

export async function completeGemini(env, cfg, payload) {
  const apiKey = cfg?.apiKey || env.GEMINI_API_KEY;
  if (!apiKey) throw new ApiError("GEMINI_API_KEY secret is not set", 500);

  const model = cfg.provider.model;
  if (isAntigravity(model)) {
    try {
      return await completeAntigravity(env, cfg, payload);
    } catch (e) {
      if (e instanceof ApiError) {
        e.model = model;
        e.url = `${cfg.provider.baseUrl}/interactions`;
      }
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
      throw e;
    }
  }

  const { system, parts, maxTokens, search } = payload;
  const url = `${cfg.provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  let last = new ApiError("model returned an empty answer");

  const shapeList = shapes(cfg, search);
  for (const shape of shapeList) {
    let data;
    try {
      data = await callJson(url, {
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: buildGeminiBody(cfg, { system, parts, maxTokens, search }, shape),
        retryOn: retryableForGemini,
      });
    } catch (e) {
      if (e instanceof ApiError) {
        e.model = model;
        e.url = url;
      }
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
    if (text) {
      const { queries, sources } = readGeminiSources(data);
      return { text, queries, sources, usage: data.usageMetadata ?? null, model };
    }

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
