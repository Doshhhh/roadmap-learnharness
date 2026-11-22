import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeInspector } from "../src/view/node-inspector.ts";
import type { Mastery } from "../src/learner-map.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { buttonByText } from "./roadmap-dom.ts";
import { createViewFixture } from "./view-host.ts";

const gitMastery: Mastery = {
  topicId: "git",
  level: "mastered",
  evidence: [
    { sessionId: "s1", at: "2026-03-01T10:00:00Z" },
    { sessionId: "s2", at: "2026-03-02T10:00:00Z" },
    { sessionId: "s3", at: "2026-03-03T10:00:00Z" },
  ],
};

function mountInspector(mastery: Mastery[], progression: "unstarted" | "consolidated" = "unstarted") {
  const fixture = createViewFixture();
  const node = makeNode("n-git", "concept", { progression, catalogTopic: { roadmap: "backend", slug: "git" } });
  const base = makePath();
  // The error ledger checks that the rendered node belongs to the path, so the node is added to the path.
  const path = { ...base, modules: base.modules.map((module, index) => (index === 0 ? { ...module, nodes: [...module.nodes, node] } : module)) };
  const updates: unknown[] = [];
  const inspector = createNodeInspector(fixture.context, fixture.root, fixture.context.signal, {
    openSession() {},
    linkExistingSession() {},
    startSession() {},
    unlinkSession() {},
    selectNode() {},
    updateNode(change) {
      updates.push(change);
    },
    updateError() {},
    decidePivot() {},
    discussPivot() {},
    knowledgeMastery: () => mastery,
  });
  return { fixture, path, node, inspector, updates };
}

test("the node panel shows evidence and reports the learner's choice only when clicked", () => {
  const { fixture, path, node, inspector, updates } = mountInspector([gitMastery]);
  try {
    inspector.render(path, node);
    const text = fixture.root.textContent ?? "";
    assert.match(text, /Studied elsewhere/);
    assert.match(text, /mastered · 3 sessions/);
    assert.match(text, /Nothing changes until you choose/);
    assert.deepEqual(updates, [], "rendering changes nothing");

    buttonByText(fixture.root, "Mark consolidated").click();
    assert.deepEqual(updates, [{ progression: "consolidated" }]);
    buttonByText(fixture.root, "Skip").click();
    assert.deepEqual(updates, [{ progression: "consolidated" }, { progression: "skipped" }]);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

function mastery(level: Mastery["level"]): Mastery {
  return { topicId: "git", level, evidence: [{ sessionId: "s1", at: "2026-03-01T10:00:00Z" }] };
}

test("seen shows the evidence text and no action buttons, and changes nothing", () => {
  const { fixture, path, node, inspector, updates } = mountInspector([mastery("seen")]);
  try {
    inspector.render(path, node);
    const text = fixture.root.textContent ?? "";
    assert.match(text, /Studied elsewhere/);
    assert.match(text, /seen · 1 sessions/);
    assert.equal(text.includes("Mark consolidated"), false);
    assert.equal(text.includes("Skip"), false);
    assert.equal(updates.length, 0);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("practiced suggests Mark consolidated and mastered suggests Skip", () => {
  const practiced = mountInspector([mastery("practiced")]);
  try {
    practiced.inspector.render(practiced.path, practiced.node);
    assert.equal(buttonByText(practiced.fixture.root, "Mark consolidated").className.includes("primary"), true);
    assert.equal(buttonByText(practiced.fixture.root, "Skip").className.includes("primary"), false);
    assert.equal(practiced.updates.length, 0);
  } finally {
    practiced.inspector.dispose();
    practiced.fixture.restore();
  }
  const mastered = mountInspector([mastery("mastered")]);
  try {
    mastered.inspector.render(mastered.path, mastered.node);
    assert.equal(buttonByText(mastered.fixture.root, "Skip").className.includes("primary"), true);
    assert.equal(buttonByText(mastered.fixture.root, "Mark consolidated").className.includes("primary"), false);
    assert.equal(mastered.updates.length, 0);
  } finally {
    mastered.inspector.dispose();
    mastered.fixture.restore();
  }
});

test("the panel shows no evidence block when there is no matching mastery", () => {
  const { fixture, path, node, inspector, updates } = mountInspector([]);
  try {
    inspector.render(path, node);
    assert.doesNotMatch(fixture.root.textContent ?? "", /Studied elsewhere/);
    assert.equal(updates.length, 0);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("a status that is already set cannot be chosen again from the evidence block", () => {
  const { fixture, path, node, inspector } = mountInspector([gitMastery], "consolidated");
  try {
    inspector.render(path, node);
    assert.equal(buttonByText(fixture.root, "Mark consolidated").disabled, true);
    assert.equal(buttonByText(fixture.root, "Skip").disabled, false);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});
