// Runs every layer suite in one go.   node test/run-all.mjs
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.startsWith("test-") && f.endsWith(".mjs")).sort();

let failed = 0;
let passed = 0;

for (const file of files) {
  console.log(`\n${"─".repeat(60)}\n  ${file}\n${"─".repeat(60)}`);
  const r = spawnSync(process.execPath, [join(here, file)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
  passed++;
}

console.log(`\n${"═".repeat(60)}`);
console.log(failed ? `  ${failed} of ${passed} suites FAILED` : `  all ${passed} suites passed`);
console.log("═".repeat(60));
process.exit(failed ? 1 : 0);