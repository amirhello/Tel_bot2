// Entrypoint. Routing only — every decision lives in another module.

import { handleAdmin, json } from "./admin.js";
import { processMessage } from "./answer.js";
import { diagnostics, reportPage, resetWebhook, setup, signWebhookSecret } from "./tools.js";

const seen = new Set();

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && req.method === "POST") return webhook(req, env, ctx);

    if (path === "/") return json({ ok: true, bot: "sayyad" });

    if (path === "/setup") {
      return json(await setup(req, env, url).catch((e) => ({ error: String(e?.message ?? e) })));
    }
    if (path === "/setup/reset") {
      return json(await resetWebhook(env).catch((e) => ({ error: String(e?.message ?? e) })));
    }

    if (path === "/diag") {
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

  // Verified by the secret we handed out at /setup if header is present.
  if (env.ADMIN_PASSWORD) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got) {
      const want = await signWebhookSecret(env.ADMIN_PASSWORD);
      if (got !== want) {
        return new Response("forbidden", { status: 403 });
      }
    }
  }

  const update = await req.json().catch(() => null);
  if (update && typeof update.update_id === "number") {
    if (seen.has(update.update_id)) return new Response("ok"); // Telegram retried a delivery
    seen.add(update.update_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  if (update?.message) ctx.waitUntil(processMessage(env, update.message));
  return new Response("ok");
}