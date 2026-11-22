import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeEvidence } from "../src/node-evidence.ts";
import type { Mastery } from "../src/learner-map.ts";

const linked = { catalogTopic: { roadmap: "backend", slug: "git" } };

function mastery(topicId: string, level: Mastery["level"], sessionIds: string[]): Mastery {
  return {
    topicId,
    level,
    evidence: sessionIds.map((sessionId, index) => ({ sessionId, at: `2026-03-0${index + 1}T10:00:00Z` })),
  };
}

test("a node without a catalog link has no evidence, even when a mastery topic exists", () => {
  assert.equal(nodeEvidence({}, [mastery("git", "mastered", ["s1", "s2", "s3"])]), null);
});

test("a linked node with no matching mastery topic has no evidence", () => {
  assert.equal(nodeEvidence(linked, []), null);
  assert.equal(nodeEvidence(linked, [mastery("docker", "practiced", ["s1"])]), null);
});

test("a matching topic with an empty evidence list is treated as no evidence", () => {
  assert.equal(nodeEvidence(linked, [{ topicId: "git", level: "seen", evidence: [] }]), null);
});

test("seen-only evidence reports level, sessions and dates but suggests nothing", () => {
  const result = nodeEvidence(linked, [mastery("git", "seen", ["s2", "s1"])]);
  assert.deepEqual(result, {
    topicId: "git",
    level: "seen",
    sessionCount: 2,
    firstAt: "2026-03-01T10:00:00Z",
    lastAt: "2026-03-02T10:00:00Z",
  });
  assert.equal(result && "suggestion" in result, false);
});

test("seen evidence gets no suggestion however many sessions it spans", () => {
  const result = nodeEvidence(linked, [mastery("git", "seen", ["s1", "s2", "s3"])]);
  assert.equal(result?.level, "seen");
  assert.equal(result?.sessionCount, 3);
  assert.equal(result && "suggestion" in result, false);
});

test("practiced evidence suggests marking the node consolidated", () => {
  const result = nodeEvidence(linked, [mastery("git", "practiced", ["s1"])]);
  assert.equal(result?.level, "practiced");
  assert.equal(result?.suggestion, "consolidated");
  assert.equal(result?.sessionCount, 1);
});

test("mastered evidence suggests skipping the node", () => {
  const result = nodeEvidence(linked, [mastery("git", "mastered", ["s1", "s2", "s3"])]);
  assert.equal(result?.level, "mastered");
  assert.equal(result?.suggestion, "skipped");
  assert.equal(result?.sessionCount, 3);
  assert.equal(result?.firstAt, "2026-03-01T10:00:00Z");
  assert.equal(result?.lastAt, "2026-03-03T10:00:00Z");
});

test("the function does not modify the node or the mastery", () => {
  const node = { catalogTopic: { roadmap: "backend", slug: "git" } };
  const input = [mastery("git", "mastered", ["s1", "s2", "s3"])];
  const before = JSON.stringify({ node, input });
  nodeEvidence(node, input);
  assert.equal(JSON.stringify({ node, input }), before);
});
