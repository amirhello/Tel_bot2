// File-based KV storage for Node.js environments.
// Matches Cloudflare KV API (get, put, delete) with zero external dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class FileKV {
  constructor(dir = "./data", filename = "store.json") {
    this.dir = dir;
    this.filePath = join(dir, filename);
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw) || {};
      }
    } catch {
      this.data = {};
    }
  }

  save() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("FileKV save failed:", err?.message || err);
    }
  }

  async get(key, type = "text") {
    const val = this.data[key];
    if (val === undefined || val === null) return null;
    if (type === "json") {
      try {
        return typeof val === "string" ? JSON.parse(val) : val;
      } catch {
        return null;
      }
    }
    return typeof val === "string" ? val : JSON.stringify(val);
  }

  async put(key, value) {
    this.data[key] = typeof value === "string" ? value : JSON.stringify(value);
    this.save();
  }

  async delete(key) {
    if (key in this.data) {
      delete this.data[key];
      this.save();
    }
  }
}
