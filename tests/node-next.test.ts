import assert from "node:assert/strict";
import { test } from "node:test";
import { NEXT_REASON_KEYS, rankNextNodes, type NextNode } from "../src/node-next.ts";
import { findNodeGaps } from "../src/node-gaps.ts";
import type { NodePrerequisites } from "../src/node-catalog-link.ts";
import { setLocale, t } from "../src/i18n.ts";

const node = (id: string, progression: NextNode["progression"] = "unstarted", extra: Partial<NextNode> = {}): NextNode => ({
  id,
  progression,
  errors: [],
  ...extra,
});

/** Prerequisites from a map of node id to prerequisite ids. */
const edges = (map: Record<string, string[]>): NodePrerequisites[] =>
  Object.entries(map).map(([nodeId, prerequisiteIds]) => ({ nodeId, prerequisiteIds, source: "catalog" as const }));

/** Gaps as the view computes them: findNodeGaps on the same nodes, with no mastery. */
const rank = (nodes: NextNode[], prerequisites: NodePrerequisites[] = [], limit?: number) => {
  const gaps = findNodeGaps({ roadmap: "fe", nodes, prerequisites, mastery: [] });
  return rankNextNodes({ nodes, prerequisites, gaps, limit });
};
const ids = (result: { nodeId: string }[]) => result.map(entry => entry.nodeId);

test("empty roadmap recommends nothing", () => {
  assert.deepEqual(rank([]), []);
  assert.deepEqual(rankNextNodes({ nodes: [], prerequisites: [], gaps: [] }), []);
});

test("a roadmap where everything is done recommends nothing", () => {
  const nodes = [node("a", "consolidated"), node("b", "skipped"), node("c", "consolidated", { optional: true })];
  assert.deepEqual(rank(nodes, edges({ b: ["a"] })), []);
});

test("only ready nodes are recommended: a dependent waits for its required prerequisite", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const prerequisites = edges({ b: ["a"], c: ["b"] });
  assert.deepEqual(ids(rank(nodes, prerequisites)), ["a"]);

  const after = [node("a", "consolidated"), node("b"), node("c")];
  assert.deepEqual(ids(rank(after, prerequisites)), ["b"]);
});

test("a skipped prerequisite counts as done", () => {
  const nodes = [node("a", "skipped"), node("b")];
  assert.deepEqual(ids(rank(nodes, edges({ b: ["a"] }))), ["b"]);
});

test("a node in progress is ready and says so", () => {
  const [result] = rank([node("a", "in_progress")]);
  assert.equal(result?.nodeId, "a");
  assert.ok(result?.reasons.some(reason => reason.key === "next.inProgress"));
});

test("optional nodes are never recommended as required, and never block", () => {
  // o is optional and not done. It is not recommended, and b, which lists only o, is still ready.
  const nodes = [node("a"), node("o", "unstarted", { optional: true }), node("b")];
  const prerequisites = edges({ b: ["o"] });
  const result = rank(nodes, prerequisites);
  assert.deepEqual(ids(result), ["a", "b"]);
  assert.ok(!ids(result).includes("o"));

  // An optional node that lists a required prerequisite is not recommended, even though it is unblocked.
  const withOptionalDependent = rank([node("a"), node("o", "unstarted", { optional: true })], edges({ o: ["a"] }));
  assert.deepEqual(ids(withOptionalDependent), ["a"]);
});

test("an optional node adds no dependents or severity to its prerequisite", () => {
  const nodes = [node("a"), node("o", "unstarted", { optional: true })];
  const [result] = rank(nodes, edges({ o: ["a"] }));
  assert.equal(result?.score, 0);
  assert.ok(!result?.reasons.some(reason => reason.key === "next.direct" || reason.key === "next.blocks"));
});

test("ties are broken by node id ascending", () => {
  const nodes = [node("z"), node("m"), node("a")];
  const result = rank(nodes);
  assert.deepEqual(ids(result), ["a", "m", "z"]);
  assert.ok(result.every(entry => entry.score === 0));
});

test("score desc comes before node id asc", () => {
  // b has an open error, so it scores 1 and goes first. a and c tie at 0 and follow in id order.
  const nodes = [node("c"), node("b", "unstarted", { errors: [openError()] }), node("a")];
  assert.deepEqual(ids(rank(nodes)), ["b", "a", "c"]);
});

test("a prerequisite that many nodes depend on ranks above the others", () => {
  // hub is needed by x, y and z: severity 3 plus 3 direct dependents.
  const nodes = [node("hub"), node("x"), node("y"), node("z"), node("lone")];
  const prerequisites = edges({ x: ["hub"], y: ["hub"], z: ["hub"] });
  const result = rank(nodes, prerequisites);
  assert.equal(result[0]?.nodeId, "hub");
  assert.equal(result[0]?.score, 6);
  assert.ok(result[0]?.reasons.some(reason => reason.key === "next.blocks" && reason.vars?.n === 3));
  assert.ok(result[0]?.reasons.some(reason => reason.key === "next.direct" && reason.vars?.n === 3));
});

test("at most the limit is returned, three by default", () => {
  const nodes = [node("a"), node("b"), node("c"), node("d"), node("e")];
  assert.equal(rank(nodes).length, 3);
  assert.deepEqual(ids(rank(nodes, [], 1)), ["a"]);
  assert.throws(() => rank(nodes, [], -1), /Invalid limit/);
});

test("a group of alternatives counts once, under its first member", () => {
  const nodes = [node("gcc", "unstarted", { alternativeGroup: "cc" }), node("clang", "unstarted", { alternativeGroup: "cc" }), node("b")];
  assert.deepEqual(ids(rank(nodes)), ["b", "gcc"]);
});

test("every reason key exists in both English and Russian", () => {
  try {
    for (const key of NEXT_REASON_KEYS) {
      setLocale("ru");
      const russian = t(key, { n: 1 });
      setLocale("en");
      const english = t(key, { n: 1 });
      assert.notEqual(russian, key);
      assert.notEqual(english, key);
      assert.notEqual(russian, english, `${key} has no Russian text`);
    }
  } finally {
    setLocale("en");
  }
});

function openError() {
  return {
    id: "e1",
    category: "misconception" as const,
    summary: "wrong model",
    resolved: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
}
