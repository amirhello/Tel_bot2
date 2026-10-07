// Dev-only: flattens src/*.js into dist/sayyad-worker.js.
//
// The source files use relative imports (import { x } from "./store.js") because that
// is what Cloudflare's Modules tab expects. This script resolves those names by reading
// the import graph, orders the modules topologically, strips the module syntax, and
// re-exports every public name so the offline test suite can import the exact bundle
// that gets deployed.
//
//   node build.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SRC = join(root, "src");

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;/gm;
const REEXPORT_RE = /^export\s*\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?\s*;\s*$/gm;

/** "./store.js" or the legacy bare "store" both mean the sibling file store.js. */
function resolveModule(file, spec) {
  const bare = spec.startsWith("./") ? spec.slice(2) : spec;
  if (!/^[\w-]+\.js$/.test(bare)) throw new Error(`${file}: unsupported import specifier "${spec}"`);
  return bare;
}

const files = readdirSync(SRC).filter((f) => f.endsWith(".js")).sort();
const sources = new Map();
const edges = new Map();

for (const file of files) {
  const raw = readFileSync(join(SRC, file), "utf8");
  sources.set(file, raw);

  const deps = new Set();
  for (const m of raw.matchAll(IMPORT_RE)) {
    deps.add(resolveModule(file, m[2]));
  }
  edges.set(file, deps);
}

/** Depth-first topological sort; throws on a missing module or a cycle. */
const ordered = [];
const state = new Map();

function visit(file, stack = []) {
  const s = state.get(file);
  if (s === "done") return;
  if (s === "visiting") throw new Error(`import cycle: ${[...stack, file].join(" -> ")}`);
  if (!sources.has(file)) throw new Error(`missing module "${file}" (imported by ${stack.at(-1) ?? "?"})`);

  state.set(file, "visiting");
  for (const dep of edges.get(file)) visit(dep, [...stack, file]);
  state.set(file, "done");
  ordered.push(file);
}

for (const file of files) visit(file);

function strip(src, file) {
  const out = src
    .replace(IMPORT_RE, "")
    .replace(REEXPORT_RE, "")
    .replace(/^export\s+(?!default\b)(const|let|var|function|async function|class)\b/gm, "$1");

  const stray = out.match(/^\s*(import|export)\s(?!default\b).*$/m);
  if (stray) throw new Error(`${file}: leftover module statement -> ${stray[0].trim()}`);
  return out.trim();
}

/** Every public name, so tests can reach any layer through the bundle. */
const exported = new Set();
for (const file of ordered) {
  const src = sources.get(file);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|function|async function|class)\s+([\w$]+)/gm)) {
    exported.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      exported.add(name);
    }
  }
}

const banner = `// ============================================================================
//  Sayyad — Telegram bot on Cloudflare Workers
//  GENERATED FILE. Do not edit by hand: edit ./src and run "node build.mjs".
//  Module order, resolved from the import graph: ${ordered.join(", ")}
// ============================================================================`;

const body = ordered
  .map((f) => `\n// ------------------------------ src/${f} ------------------------------\n${strip(sources.get(f), f)}\n`)
  .join("");

const out = `${banner}\n${body}\nexport { ${[...exported].sort().join(", ")} };\n`;

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "sayyad-worker.js"), out, "utf8");

console.log(
  `dist/sayyad-worker.js  ${(out.length / 1024).toFixed(1)} KB  ` +
    `(${out.split("\n").length} lines, ${ordered.length} modules, ${exported.size} exports)`,
);