// Entrypoint. Routing only — every decision lives in another module.

import { handleAdmin, isAuthed, json, timingSafeEqual } from "./admin.js";
import { processMessage, processCallback } from "./answer.js";
import { diagnostics, reportPage, resetWebhook, setup, signWebhookSecret } from "./tools.js";

const seen = new Set();

export default {
  async fetch(req, env, ctx) {
    const contentLength = Number(req.headers.get("content-length"));
    if (contentLength && contentLength > 2 * 1024 * 1024) {
      return new Response("Payload Too Large", { status: 413 });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && req.method === "POST") return webhook(req, env, ctx);

    if (path === "/") return json({ ok: true, bot: "sayyad" });

    if (path === "/setup") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
      return json(await setup(req, env, url).catch((e) => ({ error: String(e?.message ?? e) })));
    }
    if (path === "/setup/reset") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
      return json(await resetWebhook(env).catch((e) => ({ error: String(e?.message ?? e) })));
    }

    if (path === "/diag") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorised" }, 401);
      const report = await diagnostics(env).catch((e) => ({ error: String(e?.message ?? e) }));
      if (url.searchParams.get("format") === "json") return json(report);
      return new Response(reportPage("Sayyad diagnostics", report), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (path.startsWith("/admin")) {
      const handled = await handleAdmin(req, env, path).catch((e) => {
        return json({ error: String(e?.message ?? e) }, 500);
      });
      if (handled) return handled;
    }

    return json({ error: "not found" }, 404);
  },
};

async function webhook(req, env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("TELEGRAM_BOT_TOKEN is not set", { status: 500 });

  // Strictly require secret token when ADMIN_PASSWORD is configured
  if (env.ADMIN_PASSWORD) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (!got) {
      return new Response("forbidden", { status: 403 });
    }
    const want = await signWebhookSecret(env.ADMIN_PASSWORD);
    if (!timingSafeEqual(got, want)) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const update = await req.json().catch(() => null);
  if (update && typeof update.update_id === "number") {
    if (seen.has(update.update_id)) return new Response("ok"); // Telegram retried a delivery
    seen.add(update.update_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  if (update?.message) ctx.waitUntil(processMessage(env, update.message));
  if (update?.callback_query) ctx.waitUntil(processCallback(env, update.callback_query));
  return new Response("ok");
}