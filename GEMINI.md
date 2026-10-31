# Server & Hosting Architecture Rules for Sayyad Bot

- **Hosting Provider:** [WispByte](https://wispbyte.com/)
- **Server Environment:** Node.js (JS container)
- **Container Resource Allocations:**
  - **RAM:** 500 MB
  - **Storage / Disk:** 1 GB
  - **CPU:** 35% vCPU
- **Execution & Entrypoint:**
  - Runs natively via `node bot.js` 24/7.
  - Architecture: Telegram Long Polling (`getUpdates`) + embedded HTTP server (Admin & Diag) on port 10638.
  - Storage: Native file-based Key-Value store (`FileKV` in `data/store.json`).
  - Zero external dependencies: pure Node.js 18+ built-ins (`node:http`, `node:fs`, `node:crypto`, `node:path`).
  - **CRITICAL:** Do NOT assume or refer to Cloudflare Workers, Wrangler, or Cloudflare KV. The production target is strictly this WispByte Node.js container.
