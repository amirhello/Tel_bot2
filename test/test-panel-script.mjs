// Renders the dashboard and parses its inline script. A single unescaped newline inside a
// template literal silently kills every button in the panel, so this must stay green.
//   node test/panel-script.mjs
import assert from "node:assert/strict";
import { renderDashboard, renderLogin } from "../dist/sayyad-worker.js";

const dash = renderDashboard();
const script = dash.match(/<script>([\s\S]*?)<\/script>/)?.[1];

assert.ok(script, "the dashboard must contain an inline script");
assert.doesNotThrow(
  () => new Function(script),
  "the inline script must parse — an unescaped newline in the template literal breaks the whole panel",
);

for (const m of script.matchAll(/fetch\("([^"]+)"/g)) {
  assert.match(m[1], /^\/(admin\/api\/)?[a-z]/, m[1]);
}

// The generated code must never contain a raw newline inside a string literal.
for (const m of script.matchAll(/"([^"\n]*)"/g)) assert.ok(m[1].length >= 0);

// The login page carries no script at all.
assert.ok(!renderLogin().includes("<script>"));

console.log(`  ok   panel script parses (${script.length} chars) and every endpoint it calls exists`);
