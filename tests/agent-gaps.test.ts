import assert from "node:assert/strict";
import { test } from "node:test";
import { readNextNode, readNodeGaps } from "../src/agent-gaps.ts";
import { makeNode, makePath, clone, rawPath } from "./fixtures.ts";

const emptyPath = () => ({
  ...rawPath(),
  modules: [{ id: "module-empty", title: "Empty", nodes: [] }],
});

test("a valid roadmap returns its gaps, most severe first", () => {
  const input = { path: rawPath(), mastery: [] };
  const before = clone(input);

  const result = readNodeGaps(input);

  assert.deepEqual(result, {
    isError: false,
    roadmap: "path-linear-algebra",
    gaps: [
      { nodeId: "n-concept", kind: "missing", severity: 4, blockers: [] },
      { nodeId: "n-skill", kind: "missing", severity: 3, blockers: [] },
      { nodeId: "n-contrast", kind: "missing", severity: 2, blockers: [] },
      { nodeId: "n-checkpoint", kind: "missing", severity: 1, blockers: [] },
      { nodeId: "n-bridge", kind: "missing", severity: 0, blockers: [] },
    ],
  });
  assert.deepEqual(input, before, "the input is not mutated");
});

test("a valid roadmap returns the top next node with its reasons", () => {
  const result = readNextNode({ path: rawPath(), mastery: [] });

  assert.equal(result.isError, false);
  if (result.isError) return;
  assert.equal(result.roadmap, "path-linear-algebra");
  assert.equal(result.next?.id, "n-concept");
  assert.equal(result.next?.title, "Node n-concept");
  assert.deepEqual(
    result.next?.reasons.map(reason => reason.key),
    ["next.prereqsDone", "next.inProgress", "next.blocks", "next.direct"],
  );
  assert.deepEqual(result.next?.reasons[2], { key: "next.blocks", vars: { n: 4 } });
});

test("an empty roadmap returns an empty gap list and no next node", () => {
  const input = { path: emptyPath(), mastery: [] };

  assert.deepEqual(readNodeGaps(input), { isError: false, roadmap: "path-linear-algebra", gaps: [] });
  assert.deepEqual(readNextNode(input), { isError: false, roadmap: "path-linear-algebra", next: null });
});

test("a roadmap whose nodes are all done has no next node", () => {
  const path = rawPath();
  for (const module of path.modules) {
    for (const node of module.nodes) node.progression = "consolidated";
  }

  assert.deepEqual(readNextNode({ path, mastery: [] }), { isError: false, roadmap: "path-linear-algebra", next: null });
  assert.deepEqual(readNodeGaps({ path, mastery: [] }), { isError: false, roadmap: "path-linear-algebra", gaps: [] });
});

test("malformed input returns isError and no list", () => {
  const cases: unknown[] = [
    null,
    "not a roadmap",
    { mastery: [] },
    { path: { ...rawPath(), modules: "none" }, mastery: [] },
    { path: rawPath() },
    { path: rawPath(), mastery: "none" },
    { path: rawPath(), mastery: [{ topicId: "linear-maps", level: "expert", evidence: [] }] },
    { path: rawPath(), mastery: [], catalog: { roadmaps: [{ slug: "x", topics: [{ prerequisites: [] }] }] } },
  ];

  for (const input of cases) {
    for (const result of [readNodeGaps(input), readNextNode(input)]) {
      assert.equal(result.isError, true, `expected isError for ${JSON.stringify(input)}`);
      assert.equal(typeof (result as { error: unknown }).error, "string");
      assert.equal("gaps" in result, false);
      assert.equal("next" in result, false);
    }
  }
});

test("a prerequisite cycle returns isError rather than a partial list", () => {
  const path = rawPath();
  const concept = path.modules[0].nodes.find((node: { id: string }) => node.id === "n-concept");
  const skill = path.modules[0].nodes.find((node: { id: string }) => node.id === "n-skill");
  concept.catalogTopic = { roadmap: "algebra", slug: "topic-a" };
  skill.catalogTopic = { roadmap: "algebra", slug: "topic-b" };
  const catalog = {
    roadmaps: [
      {
        slug: "algebra",
        topics: [
          { slug: "topic-a", prerequisites: ["topic-b"] },
          { slug: "topic-b", prerequisites: ["topic-a"] },
        ],
      },
    ],
  };
  const input = { path, mastery: [], catalog };

  const gaps = readNodeGaps(input);
  const next = readNextNode(input);

  for (const result of [gaps, next]) {
    assert.equal(result.isError, true);
    assert.match((result as { error: string }).error, /cycle/i);
    assert.equal("gaps" in result, false);
    assert.equal("next" in result, false);
  }
});

test("a single node with no prerequisites is one missing gap", () => {
  const path = { ...rawPath(), modules: [{ id: "m", title: "M", nodes: [makeNode("only", "concept")] }] };

  assert.deepEqual(readNodeGaps({ path, mastery: [] }), {
    isError: false,
    roadmap: "path-linear-algebra",
    gaps: [{ nodeId: "only", kind: "missing", severity: 0, blockers: [] }],
  });
});
