# Server Hosting Specifications — Sayyad Bot

## Infrastructure Overview
- **Provider:** [WispByte](https://wispbyte.com/)
- **Server Type:** Node.js (JavaScript container)
- **Primary Entrypoint:** `bot.js`
- **Startup Command:** `node bot.js`

## Resource Limits
- **Memory (RAM):** 500 MB
- **Disk Storage:** 1,024 MB (1 GB)
- **CPU Allocation:** 35% vCPU

## Storage & Network Design
- **Persistence:** Local JSON database via `FileKV` located at `data/store.json`.
- **Telegram Connectivity:** Telegram Bot API Long Polling (`getUpdates` loop with `timeout=25`).
- **HTTP Services:** Embedded Node.js HTTP server listening on port 10638 (and fallback port 8080) for `/admin` control dashboard and `/diag`.
