// Sayyad Telegram Bot — Node.js Server & 24/7 Long-Polling Runner
// Zero-dependency: runs natively on Node.js 18+ with pure built-in modules.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { processMessage } from "./src/answer.js";
import { handleAdmin, isAuthed } from "./src/admin.js";
import { diagnostics, reportPage } from "./src/tools.js";
import { getKeyPool, getKeyPoolStatus, setStateFilePath } from "./src/keyPool.js";
import { FileKV } from "./src/nodeStore.js";
import { NodeWebSocket } from "./src/nodeWs.js";

// Persist key pool state across restarts in Node.js daemon
setStateFilePath(join(process.cwd(), "data", "keys-state.json"));

// Native WebSocket polyfill for Node.js < 21
if (typeof globalThis.WebSocket !== "function") {
  globalThis.WebSocket = NodeWebSocket;
}

// Global unhandled error handlers
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

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
          process.env[key] = val;
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

const primaryPort = Number(process.env.PORT || process.env.SERVER_PORT || 10638);
const secondaryPort = primaryPort === 10638 ? 8080 : 10638;
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB
let running = true;

// 2. HTTP Request Handler for /admin, /diag and health-checks
async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const contentLength = Number(req.headers["content-length"]);
    if (contentLength && contentLength > MAX_BODY_SIZE) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      return;
    }

    if (path === "/") {
      const keys = getKeyPool(env);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bot: "sayyad", status: "running", keysLoaded: keys.length }));
      return;
    }

    if (path === "/diag") {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const standardReq = new Request(url.toString(), {
        method: req.method,
        headers,
      });

      if (!(await isAuthed(standardReq, env))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorised" }));
        return;
      }

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
      let totalBytes = 0;
      const bodyChunks = [];
      let tooLarge = false;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_SIZE) {
          tooLarge = true;
          break;
        }
        bodyChunks.push(chunk);
      }
      if (tooLarge) {
        req.destroy();
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        return;
      }
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
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip === "localhost" ||
    ip === "0.0.0.0"
  );
}

function printStartupBanner(currentPort) {
  const publicBase = (process.env.PUBLIC_URL || `http://localhost:${currentPort}`).replace(/\/+$/, "");
  const serverIp = process.env.SERVER_IP || process.env.PUBLIC_IP || null;

  console.log("\n" + "=".repeat(66));
  console.log("  🤖 SAYYAD TELEGRAM BOT — CONTROL PANEL & DIAGNOSTIC LINKS");
  console.log("=".repeat(66));
  console.log(`  ⚙️  Admin Dashboard:    ${publicBase}/admin`);
  console.log(`  🩺  System Diagnostics:  ${publicBase}/diag`);
  console.log(`  📄  Diagnostics (JSON):  ${publicBase}/diag?format=json`);
  console.log(`  🔑  Key Pool API Status: ${publicBase}/admin/api/keys`);
  console.log(`  📊  Stats & Logs API:    ${publicBase}/admin/api/state`);
  console.log(`  💓  Healthcheck / Root:  ${publicBase}/`);
  console.log("-".repeat(66));
  if (serverIp && isPrivateIp(serverIp)) {
    console.log(`  🏠  Internal Docker IP:  http://${serverIp}:${currentPort}/admin`);
  }
  console.log(`  💻  Localhost Link:      http://localhost:${currentPort}/admin`);
  console.log("=".repeat(66) + "\n");
}

const server = createServer(requestHandler);
server.listen(primaryPort, "0.0.0.0", () => {
  printStartupBanner(primaryPort);
});

// Dual-listen: binds secondary port too so requests always reach the server
let altServer = null;
if (primaryPort !== secondaryPort) {
  try {
    altServer = createServer(requestHandler);
    altServer.on("error", () => {});
    altServer.listen(secondaryPort, "0.0.0.0");
  } catch {}
}

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
        let waitSec = 3;
        try {
          const errData = await res.json();
          if (errData?.parameters?.retry_after) waitSec = Math.max(1, errData.parameters.retry_after);
        } catch {}
        if (res.status === 429) {
          console.warn(`⚠️ [Telegram] Rate limited (HTTP 429). Pausing getUpdates for ${waitSec}s...`);
        } else if (res.status === 502 || res.status === 504) {
          console.warn(`⚠️ [Telegram] Server temporary error (HTTP ${res.status}). Waiting ${waitSec}s...`);
        } else {
          console.error(`Telegram getUpdates HTTP ${res.status}`);
        }
        await sleep(waitSec * 1000);
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
          if (data.result.length > 1) await sleep(40);
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

  let closed = 0;
  let expected = 1;
  const onClose = () => {
    closed++;
    if (closed >= expected) {
      console.log("Server closed. Goodbye!");
      process.exit(0);
    }
  };

  server.close(onClose);
  if (altServer) {
    expected++;
    try {
      altServer.close(onClose);
    } catch {
      onClose();
    }
  }
  setTimeout(() => process.exit(0), 3000);
}

startPolling();
