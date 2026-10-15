// Sayyad Telegram Bot — Node.js Server & 24/7 Long-Polling Runner
// Zero-dependency: runs natively on Node.js 18+ with pure built-in modules.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { processMessage } from "./src/answer.js";
import { handleAdmin } from "./src/admin.js";
import { diagnostics, reportPage } from "./src/tools.js";
import { getKeyPool, getKeyPoolStatus } from "./src/keyPool.js";
import { FileKV } from "./src/nodeStore.js";

// 1. Lightweight .env loader (zero external packages)
function loadEnv() {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          let val = trimmed.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!(key in process.env)) {
            process.env[key] = val;
          }
        }
      }
    } catch (e) {
      console.warn("Could not read .env file:", e.message);
    }
  }
}

loadEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("❌ ERROR: TELEGRAM_BOT_TOKEN is not set in environment or .env file!");
  console.error("Please create a .env file and add TELEGRAM_BOT_TOKEN=your_bot_token");
  process.exit(1);
}

const env = {
  TELEGRAM_BOT_TOKEN: token,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123",
  GEMINI_API_KEYS: process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || (process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(/[\r\n,]+/)[0]?.trim() : undefined),
  API_KEY: process.env.API_KEY || process.env.OPENROUTER_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || process.env.API_KEY,
  CONFIG: new FileKV(join(process.cwd(), "data"), "store.json"),
};

const port = Number(process.env.PORT || process.env.SERVER_PORT || 10638);
let running = true;

// 2. Start HTTP server for /admin, /diag and health-checks
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") {
      const keys = getKeyPool(env);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bot: "sayyad", status: "running", keysLoaded: keys.length }));
      return;
    }

    if (path === "/diag") {
      const report = await diagnostics(env).catch((e) => ({ error: String(e?.message ?? e) }));
      if (url.searchParams.get("format") === "json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(report, null, 2));
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(reportPage("Sayyad diagnostics", report));
      }
      return;
    }

    if (path.startsWith("/admin")) {
      // Build Web Standard Request to reuse existing handleAdmin
      const bodyChunks = [];
      for await (const chunk of req) bodyChunks.push(chunk);
      const body = bodyChunks.length ? Buffer.concat(bodyChunks) : null;

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }

      const standardReq = new Request(url.toString(), {
        method: req.method,
        headers,
        body: req.method === "POST" || req.method === "PUT" ? body : undefined,
      });

      const response = await handleAdmin(standardReq, env, path).catch((e) => {
        return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500 });
      });

      if (response) {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        const ab = await response.arrayBuffer();
        res.end(Buffer.from(ab));
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

async function printStartupBanner(port) {
  let publicIp = process.env.PUBLIC_IP || process.env.SERVER_IP || "78.154.103.39";
  if (!publicIp || publicIp === "127.0.0.1") {
    try {
      const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (ip && ip.length >= 7 && ip.length <= 45) publicIp = ip;
      }
    } catch {}
  }

  const baseLocal = `http://localhost:${port}`;
  const basePublic = publicIp ? `http://${publicIp}:${port}` : null;
  const baseCustom = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, "") : null;
  const primaryBase = baseCustom || basePublic || baseLocal;

  console.log("\n" + "=".repeat(66));
  console.log("  🤖 SAYYAD TELEGRAM BOT — CONTROL PANEL & DIAGNOSTIC LINKS");
  console.log("=".repeat(66));
  console.log(`  ⚙️  Admin Dashboard:    ${primaryBase}/admin`);
  console.log(`  🩺  System Diagnostics:  ${primaryBase}/diag`);
  console.log(`  📄  Diagnostics (JSON):  ${primaryBase}/diag?format=json`);
  console.log(`  🔑  Key Pool API Status: ${primaryBase}/admin/api/keys`);
  console.log(`  📊  Stats & Logs API:    ${primaryBase}/admin/api/stats`);
  console.log(`  💓  Healthcheck / Root:  ${primaryBase}/`);

  if (basePublic && primaryBase !== basePublic) {
    console.log("-".repeat(66));
    console.log(`  🌐  Direct Public Link:  http://${publicIp}:${port}/admin`);
  }
  if (primaryBase !== baseLocal) {
    console.log(`  🏠  Localhost Link:      ${baseLocal}/admin`);
  }
  console.log("=".repeat(66) + "\n");
}

server.listen(port, "0.0.0.0", () => {
  printStartupBanner(port).catch(() => {});
});

// 3. Main Telegram Long Polling Loop
async function startPolling() {
  console.log("🚀 Initializing Sayyad Telegram Bot in Long Polling mode...");

  // Clear any old webhook so long polling connects immediately
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    console.log("✅ Webhook cleared, starting getUpdates polling loop.");
  } catch (e) {
    console.warn("⚠️ Could not clear webhook:", e.message);
  }

  // Probe identity
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const me = await meRes.json();
    if (me?.ok) {
      console.log(`🤖 Logged in as @${me.result.username} (ID: ${me.result.id})`);
    }
  } catch (e) {
    console.warn("⚠️ getMe warning:", e.message);
  }

  const keys = getKeyPool(env);
  console.log(`🔑 Loaded ${keys.length} Gemini API keys into the multi-key pool.`);

  let offset = 0;
  while (running) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });
      if (!res.ok) {
        console.error(`Telegram getUpdates HTTP ${res.status}`);
        await sleep(3000);
        continue;
      }

      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.result)) {
        await sleep(2000);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          // Process message asynchronously
          processMessage(env, update.message).catch((err) => {
            console.error("Message processing error:", err?.message || err);
          });
        }
      }
    } catch (pollErr) {
      if (!running) break;
      // Normal network hiccup or timeout: wait 2s and resume loop
      await sleep(2000);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Graceful shutdown
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  running = false;
  server.close(() => {
    console.log("Server closed. Goodbye!");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

startPolling();
