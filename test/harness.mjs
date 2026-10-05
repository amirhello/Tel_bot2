// Shared harness. Every test imports the generated bundle, so the thing under test is the
// exact file that gets deployed — not a parallel copy of the logic.
import assert from "node:assert/strict";

export const M = await import("../dist/sayyad-worker.js");

const suite = (process.argv[2] ?? "suite").padEnd(12);
let passed = 0;

export async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${String(e?.message ?? e).split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
}

export function done(label) {
  console.log(`\n${passed} checks passed — ${label ?? suite}`);
}

/** An in-memory stand-in for the KV namespace binding. */
export function fakeKV(seed = {}) {
  const store = { ...seed };
  return {
    store,
    async get(k, type) {
      const v = k in store ? store[k] : null;
      if (v === null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      store[k] = v;
    },
  };
}

export function env(extra = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "123:TEST",
    ADMIN_PASSWORD: "hunter2",
    CONFIG: fakeKV(),
    ...extra,
  };
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export { assert };