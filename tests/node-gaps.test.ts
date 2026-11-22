import assert from "node:assert/strict";
import { test } from "node:test";
import { nodePrerequisites } from "../src/node-catalog-link.ts";
import type { NodePrerequisites } from "../src/node-catalog-link.ts";
import { findNodeGaps, type GapNode } from "../src/node-gaps.ts";
import type { Mastery } from "../src/learner-map.ts";

const node = (id: string, progression: GapNode["progression"] = "unstarted", extra: Partial<GapNode> = {}): GapNode => ({
  id,
  progression,
  ...extra,
});

/** Prerequisites from a map of node id to prerequisite ids. */
const edges = (map: Record<string, string[]>): NodePrerequisites[] =>
  Object.entries(map).map(([nodeId, prerequisiteIds]) => ({ nodeId, prerequisiteIds, source: "catalog" as const }));

const known = (topicId: string): Mastery => ({
  topicId,
  level: "seen",
  evidence: [{ sessionId: "s1", at: "2026-01-01T00:00:00Z" }],
});

const run = (nodes: GapNode[], prerequisites: NodePrerequisites[] = [], mastery: Mastery[] = []) =>
  findNodeGaps({ roadmap: "fe", nodes, prerequisites, mastery });

test("empty roadmap produces no gaps", () => {
  assert.deepEqual(run([]), []);
});

test("missing gap: an unseen node is scored by the nodes that depend on it", () => {
  const nodes = [node("html"), node("css"), node("js", "unstarted")];
  assert.deepEqual(run(nodes, edges({ js: ["html", "css"] })), [
    { roadmap: "fe", nodeId: "css", kind: "missing", severity: 1 },
    { roadmap: "fe", nodeId: "html", kind: "missing", severity: 1 },
    { roadmap: "fe", nodeId: "js", kind: "missing", severity: 0 },
  ]);
});

test("weak prerequisite: a finished node with an unseen prerequisite is blocked", () => {
  const nodes = [node("html", "consolidated"), node("css"), node("js", "consolidated")];
  assert.deepEqual(run(nodes, edges({ js: ["html", "css"] })), [
    { roadmap: "fe", nodeId: "css", kind: "missing", severity: 1 },
    { roadmap: "fe", nodeId: "js", kind: "weak_prereq", blockedBy: ["css"], severity: 1 },
  ]);
});

test("knowledge graph mastery covers a linked node through its catalog topic", () => {
  const nodes = [
    node("css", "unstarted", { catalogTopic: { roadmap: "frontend", slug: "css" } }),
    node("js", "consolidated", { catalogTopic: { roadmap: "frontend", slug: "javascript" } }),
  ];
  const prerequisites = edges({ js: ["css"] });
  // Without evidence css is unseen and blocks js.
  assert.deepEqual(run(nodes, prerequisites), [
    { roadmap: "fe", nodeId: "css", kind: "missing", severity: 1 },
    { roadmap: "fe", nodeId: "js", kind: "weak_prereq", blockedBy: ["css"], severity: 1 },
  ]);
  // Mastery for the css catalog topic covers it.
  assert.deepEqual(run(nodes, prerequisites, [known("css")]), []);
});

test("severity sorts before roadmap and nodeId", () => {
  const nodes = [node("a1"), node("root"), node("z2"), node("z3")];
  const gaps = run(nodes, edges({ a1: ["root"], z2: ["root"] }));
  assert.deepEqual(
    gaps.map(gap => [gap.nodeId, gap.severity]),
    [
      ["root", 2],
      ["a1", 0],
      ["z2", 0],
      ["z3", 0],
    ],
  );
});

test("a prerequisite cycle throws an error that names the loop", () => {
  assert.throws(
    () => run([node("a"), node("b")], edges({ a: ["b"], b: ["a"] })),
    /Prerequisite cycle: a -> b -> a/,
  );
  assert.throws(() => run([node("a")], edges({ a: ["a"] })), /Prerequisite cycle: a -> a/);
});

test("a cycle through alternatives is rejected once the group is collapsed", () => {
  // a1 (group g) needs b; b needs a2 (group g). Each node alone is acyclic; the unit graph is not.
  const nodes = [node("a1", "unstarted", { alternativeGroup: "g" }), node("b"), node("a2", "unstarted", { alternativeGroup: "g" })];
  assert.throws(() => run(nodes, edges({ a1: ["b"], b: ["a2"] })), /Prerequisite cycle/);
});

test("unknown prerequisite and duplicate node ids throw", () => {
  assert.throws(() => run([node("js")], edges({ js: ["ghost"] })), /Unknown prerequisite "ghost" for node "js"/);
  assert.throws(() => run([node("js"), node("js")]), /Duplicate node id "js"/);
});

test("optional nodes are never gaps", () => {
  const nodes = [node("core", "consolidated"), node("extras", "unstarted", { optional: true })];
  assert.deepEqual(run(nodes), []);
});

test("optional nodes do not block, but their own unseen prerequisites still do", () => {
  // An optional tool sits between a required base and a finished node.
  const nodes = [
    node("base"),
    node("tool", "unstarted", { optional: true }),
    node("js", "consolidated"),
  ];
  assert.deepEqual(run(nodes, edges({ tool: ["base"], js: ["tool"] })), [
    { roadmap: "fe", nodeId: "base", kind: "missing", severity: 1 },
    { roadmap: "fe", nodeId: "js", kind: "weak_prereq", blockedBy: ["base"], severity: 1 },
  ]);

  // An optional prerequisite alone blocks nothing.
  const direct = [node("tool", "unstarted", { optional: true }), node("js", "consolidated")];
  assert.deepEqual(run(direct, edges({ js: ["tool"] })), []);
});

test("a group of alternatives is one gap, and dependents count it once", () => {
  const nodes = [
    node("gcc", "unstarted", { alternativeGroup: "compiler" }),
    node("clang", "unstarted", { alternativeGroup: "compiler" }),
    node("build"),
  ];
  // build needs both alternatives; the group is still one unit with one dependent.
  assert.deepEqual(run(nodes, edges({ build: ["gcc", "clang"] })), [
    { roadmap: "fe", nodeId: "gcc", kind: "missing", severity: 1, alternatives: ["gcc", "clang"] },
    { roadmap: "fe", nodeId: "build", kind: "missing", severity: 0 },
  ]);
});

test("a group with one finished member is covered and is not a gap", () => {
  const nodes = [
    node("gcc", "unstarted", { alternativeGroup: "compiler" }),
    node("clang", "consolidated", { alternativeGroup: "compiler" }),
    node("build"),
  ];
  assert.deepEqual(run(nodes, edges({ build: ["gcc", "clang"] })), [
    { roadmap: "fe", nodeId: "build", kind: "missing", severity: 0 },
  ]);
});

test("skipped counts as done", () => {
  // A skipped prerequisite is satisfied: nothing is missing or blocked.
  assert.deepEqual(run([node("base", "skipped"), node("js", "consolidated")], edges({ js: ["base"] })), []);

  // A skipped node is not a gap itself, and it does not make its dependent unstarted-blocked.
  assert.deepEqual(run([node("base", "skipped"), node("js")], edges({ js: ["base"] })), [
    { roadmap: "fe", nodeId: "js", kind: "missing", severity: 0 },
  ]);

  // Contrast: an in-progress prerequisite is still unseen and blocks.
  assert.deepEqual(run([node("base", "in_progress"), node("js", "consolidated")], edges({ js: ["base"] })), [
    { roadmap: "fe", nodeId: "base", kind: "missing", severity: 1 },
    { roadmap: "fe", nodeId: "js", kind: "weak_prereq", blockedBy: ["base"], severity: 1 },
  ]);
});

test("without catalog links, prerequisites fall back to module order", () => {
  const nodes = [node("a"), node("b", "consolidated"), node("c")];
  const prerequisites = nodePrerequisites(nodes, { roadmaps: [] });
  assert.deepEqual(run(nodes, prerequisites), [
    { roadmap: "fe", nodeId: "a", kind: "missing", severity: 2 },
    { roadmap: "fe", nodeId: "b", kind: "weak_prereq", blockedBy: ["a"], severity: 1 },
    { roadmap: "fe", nodeId: "c", kind: "missing", severity: 0 },
  ]);
});
