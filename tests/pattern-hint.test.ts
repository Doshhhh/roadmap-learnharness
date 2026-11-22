/** Question-pattern hints (issue #35): the node-type mapping, the setting that hides the line,
 * validation of old settings data, and EN/RU coverage of every new string. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DISPLAY, NODE_TYPES, validatePluginSettings } from "../src/domain.ts";
import type { ChildSessionKind, NodeType } from "../src/domain.ts";
import { tables, setLocale, t } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import { nodePatternHintKey, patternHintKey } from "../src/pattern-hint.ts";
import { createNodeInspector } from "../src/view/node-inspector.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { createViewFixture } from "./view-host.ts";

const EXPECTED: Record<NodeType, { teaching: string | null; practice: string | null }> = {
  holistic: { teaching: "pattern.hint.overview", practice: "pattern.hint.scenario" },
  concept: { teaching: "pattern.hint.explainBack", practice: "pattern.hint.recall" },
  contrast: { teaching: "pattern.hint.compare", practice: "pattern.hint.compare" },
  skill: { teaching: null, practice: "pattern.hint.worked" },
  checkpoint: { teaching: null, practice: "pattern.hint.selfTest" },
  bridge: { teaching: "pattern.hint.bridge", practice: null },
};

const KINDS: ChildSessionKind[] = ["teaching", "practice"];

test("each node type maps to its suggested template per session kind", () => {
  for (const type of NODE_TYPES) {
    for (const kind of KINDS) {
      assert.equal(patternHintKey(type, kind), EXPECTED[type][kind], `${type} / ${kind}`);
    }
  }
});

test("the panel line prefers the practice hint and falls back to the lesson hint", () => {
  assert.equal(nodePatternHintKey("skill"), "pattern.hint.worked");
  assert.equal(nodePatternHintKey("bridge"), "pattern.hint.bridge");
  assert.equal(nodePatternHintKey("concept"), "pattern.hint.recall");
});

test("hint wording suggests and never claims a template is selected", () => {
  setLocale("en");
  for (const type of NODE_TYPES) {
    const key = nodePatternHintKey(type);
    if (!key) continue;
    const text = t(key);
    assert.match(text, /^Tip: /);
    assert.doesNotMatch(text, /selected|applied|chosen|using/i);
  }
});

function mountPanel(type: NodeType, showPatternHints?: () => boolean) {
  const fixture = createViewFixture();
  const node = makeNode(`n-${type}`, type);
  const base = makePath();
  // The error ledger checks that the rendered node belongs to the path.
  const path = { ...base, modules: base.modules.map((module, index) => (index === 0 ? { ...module, nodes: [...module.nodes, node] } : module)) };
  const inspector = createNodeInspector(fixture.context, fixture.root, fixture.context.signal, {
    openSession() {},
    linkExistingSession() {},
    startSession() {},
    unlinkSession() {},
    selectNode() {},
    updateNode() {},
    updateError() {},
    decidePivot() {},
    discussPivot() {},
    ...(showPatternHints ? { showPatternHints } : {}),
  });
  return { fixture, path, node, inspector };
}

test("the node panel shows the hint line under the session actions", () => {
  setLocale("en");
  const { fixture, path, node, inspector } = mountPanel("skill");
  try {
    inspector.render(path, node);
    const line = fixture.root.querySelector(".rm-insp-hint");
    assert.ok(line, "hint line is rendered");
    assert.equal(line.textContent, t("pattern.hint.worked"));
    assert.equal(line.parentElement?.classList.contains("rm-insp-foot"), true, "sits in the session footer");
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("the display setting turns the hint line off", () => {
  setLocale("en");
  const { fixture, path, node, inspector } = mountPanel("skill", () => false);
  try {
    inspector.render(path, node);
    assert.equal(fixture.root.querySelector(".rm-insp-hint"), null);
    assert.doesNotMatch(fixture.root.textContent ?? "", /Tip: /);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("the display setting defaults on, and old settings data without it still validates", () => {
  assert.equal(DEFAULT_DISPLAY.patternHints, true);
  const old = validatePluginSettings({ artifactDefaults: {}, display: { language: "en", defaultView: "graph", showOptional: false } });
  assert.equal(old.ok, true);
  if (!old.ok) return;
  assert.deepEqual(old.value.display, { language: "en", defaultView: "graph", showOptional: false, patternHints: true });

  const off = validatePluginSettings({ artifactDefaults: {}, display: { ...DEFAULT_DISPLAY, patternHints: false } });
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.value.display?.patternHints, false);

  const bad = validatePluginSettings({ artifactDefaults: {}, display: { ...DEFAULT_DISPLAY, patternHints: "no" } });
  assert.equal(bad.ok, false, "a non-boolean value is rejected");
});

test("every new pattern-hint and setting string exists in both EN and RU", () => {
  const keys = new Set<MessageKey>();
  for (const type of NODE_TYPES) for (const kind of KINDS) {
    const key = patternHintKey(type, kind);
    if (key) keys.add(key);
  }
  keys.add("s.patternHints");
  keys.add("s.patternHintsDesc");
  for (const key of keys) {
    assert.ok(tables.en[key], `en: ${key}`);
    assert.ok(tables.ru[key], `ru: ${key}`);
    assert.notEqual(tables.ru[key], tables.en[key], `ru is translated: ${key}`);
  }
});
