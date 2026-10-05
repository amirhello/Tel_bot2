// OpenAI-compatible providers: OpenRouter, justwoker, and Gemini's compatibility layer.
//
// Wire format: { type: "image_url" | "video_url" | "input_audio", ... }

import { ApiError, callJson, isShapeError } from "http";

/** Neutral part -> OpenAI content part. */
export function toOpenAIPart(part) {
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

export async function completeOpenAI(env, cfg, { system, parts, maxTokens }) {
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