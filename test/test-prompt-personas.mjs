import { assert, t, done } from "./harness.mjs";
import { MODES, MODE_LABELS, DEFAULT_PERSONAS, buildSystemPrompt } from "../src/prompt.js";

await t("MODES contains all 6 personas", () => {
  const expected = ["psychologist", "friend", "smart", "rude", "wolf", "polite"];
  assert.equal(MODES.length, 6);
  for (const m of expected) {
    assert.ok(MODES.includes(m), `missing mode: ${m}`);
    assert.ok(MODE_LABELS[m], `missing label for ${m}`);
    assert.ok(DEFAULT_PERSONAS[m], `missing default persona for ${m}`);
    assert.ok(DEFAULT_PERSONAS[m].length > 100, `persona prompt too short: ${m}`);
  }
});

await t("buildSystemPrompt correctly builds prompt for every persona", () => {
  for (const mode of MODES) {
    const prompt = buildSystemPrompt({ mode, personas: DEFAULT_PERSONAS });
    assert.ok(prompt.includes("تو «سید» هستی"), "must include base rules");
    assert.ok(prompt.includes(DEFAULT_PERSONAS[mode]), `prompt must include persona body for ${mode}`);
  }
});

await t("psychologist persona reflects empathy and listening", () => {
  assert.match(DEFAULT_PERSONAS.psychologist, /روانشناس/);
  assert.match(DEFAULT_PERSONAS.psychologist, /همدل/);
});

await t("friend persona reflects Tehrani slang and brotherly loyalty", () => {
  assert.match(DEFAULT_PERSONAS.friend, /رفیق فاب/);
  assert.match(DEFAULT_PERSONAS.friend, /مشتی/);
});

await t("wolf persona reflects pragmatic market and money focus", () => {
  assert.match(DEFAULT_PERSONAS.wolf, /گرگ بازار/);
  assert.match(DEFAULT_PERSONAS.wolf, /پول/);
});

await t("rude persona has biting sarcasm without direct curse slurs", () => {
  assert.match(DEFAULT_PERSONAS.rude, /بی‌رحم/);
  assert.match(DEFAULT_PERSONAS.rude, /سارکاستیک/);
  // Ensure gratuitous slurs from older version are removed
  assert.ok(!DEFAULT_PERSONAS.rude.includes("حروم‌زاده"));
  assert.ok(!DEFAULT_PERSONAS.rude.includes("خارکصه"));
});

done();
