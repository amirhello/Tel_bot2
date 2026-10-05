// Operator routes: /diag (is anything broken?) and /setup (point Telegram here).

import { complete } from "llm";
import { DEFAULT_PERSONAS } from "prompt";
import { loadConfig } from "store";
import { deleteWebhook, getMe, getWebhookInfo, setWebhook } from "telegram";
import { esc } from "text";

/** A live probe of both the Telegram side and the configured model. */
export async function diagnostics(env) {
  const out = { provider: null, model: null, checks: {} };

  if (!env.TELEGRAM_BOT_TOKEN) {
    out.checks.telegram = "TELEGRAM_BOT_TOKEN secret is missing";
  } else {
    const me = await getMe(env.TELEGRAM_BOT_TOKEN);
    out.checks.telegram = { ok: !!me?.ok, username: me?.result?.username, error: me?.description };
    const wh = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN);
    out.checks.webhook = {
      url: wh?.result?.url,
      pending: wh?.result?.pending_update_count,
      lastError: wh?.result?.last_error_message,
    };
  }

  const cfg = (await loadConfig(env, DEFAULT_PERSONAS)).config;
  out.provider = cfg.provider.kind;
  out.model = cfg.provider.model;
  out.endpoint =
    cfg.provider.kind === "gemini"
      ? `${cfg.provider.baseUrl}/models/${cfg.provider.model}:generateContent`
      : `${cfg.provider.baseUrl}/chat/completions`;

  out.checks.credentials = {
    gemini: env.GEMINI_API_KEY ? "set" : "missing",
    openai: env.API_KEY || env.OPENROUTER_API_KEY ? "set" : "missing",
  };

  try {
    const r = await complete(env, cfg, {
      system: "You are Sayyad. Answer with one short Persian word.",
      parts: [{ type: "text", text: "say: تست" }],
      maxTokens: 64,
    });
    out.checks.model = { ok: true, sample: r.text.slice(0, 120), usage: r.usage };
  } catch (e) {
    out.checks.model = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }

  out.note = "Video and audio are only sent through the Gemini native provider.";
  return out;
}

/** Point Telegram's webhook at this Worker. */
export async function setup(req, env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) return { error: "TELEGRAM_BOT_TOKEN is not set" };

  const plain = url.searchParams.get("plain") === "1" || !env.ADMIN_PASSWORD;
  const secretToken = plain ? undefined : await signWebhookSecret(env.ADMIN_PASSWORD);
  const target = url.searchParams.get("url") ?? url.origin;

  const set = await setWebhook(env.TELEGRAM_BOT_TOKEN, target, secretToken);
  const info = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN);
  return { target, secret_token_used: !!secretToken, setWebhook: set, getWebhookInfo: info };
}

export async function resetWebhook(env) {
  return deleteWebhook(env.TELEGRAM_BOT_TOKEN);
}

export async function signWebhookSecret(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sayyad-webhook-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Wrap a report in a minimal readable page. */
export function reportPage(title, data) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="background:#0e1117;color:#e6edf3;font:14px ui-monospace,monospace;padding:24px">
<h3>${esc(title)}</h3><pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
}