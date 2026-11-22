import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphChain, GraphNode } from "learnharness-plugin-api";
import { MASTERED_SESSION_THRESHOLD, deriveMastery, readLearnerMap, topicKey } from "../src/learner-map.ts";

const NODE_AT = "2026-01-02T00:00:00Z";

function node(
  id: string,
  name: string,
  provenance: GraphNode["provenance"],
  createdAt = NODE_AT,
  aliases: string[] = [],
): GraphNode {
  return { id, name, statement: `${name} is true.`, aliases, createdAt, provenance };
}

function chain(id: string, premises: string[], conclusion: string, chatIds: string[], createdAt = NODE_AT): GraphChain {
  return { id, premises, conclusion, provenance: chatIds.map(chatId => ({ chatId, messageId: "m" })), createdAt };
}

test("topicKey normalizes names into lowercase hyphen slugs", () => {
  assert.equal(topicKey("React Hooks"), "react-hooks");
  assert.equal(topicKey("  Café—Latte!  "), "cafe-latte");
  assert.equal(topicKey("C++"), "c-plus-plus");
  assert.equal(topicKey("C#"), "c-sharp");
  assert.equal(topicKey("***"), "");
});

test("a proposition seen in one session is seen with evidence", () => {
  const result = deriveMastery({
    propositions: [node("n1", "Closures", [{ chatId: "chat-a", messageId: "m1" }], "2026-01-01T10:00:00Z")],
    chains: [],
  });
  assert.deepEqual(result, [
    { topicId: "closures", level: "seen", evidence: [{ sessionId: "chat-a", at: "2026-01-01T10:00:00Z" }] },
  ]);
});

test("a topic used in a reasoning chain is practiced", () => {
  const result = deriveMastery({
    propositions: [node("n1", "Promises", [{ chatId: "chat-a", messageId: "m1" }]), node("n2", "Async/await", [])],
    chains: [chain("arg_1", ["n1"], "n2", ["chat-b"], "2026-02-01T00:00:00Z")],
  });
  const promises = result.find(m => m.topicId === "promises");
  assert.equal(promises?.level, "practiced");
  assert.deepEqual(promises?.evidence.map(e => e.sessionId), ["chat-a", "chat-b"]);
  // Async/await has no provenance of its own, but the chain names it, so it is practiced from chat-b.
  assert.equal(result.find(m => m.topicId === "async-await")?.level, "practiced");
});

test("practice in enough distinct sessions makes a topic mastered", () => {
  const sessions = Array.from({ length: MASTERED_SESSION_THRESHOLD }, (_, i) => `chat-${i}`);
  const result = deriveMastery({
    propositions: [node("n1", "Recursion", [{ chatId: sessions[0]!, messageId: "m" }])],
    chains: sessions.map((s, i) => chain(`arg_${i}`, ["n1"], "n1", [s])),
  });
  assert.equal(result[0]?.level, "mastered");
});

test("practice in fewer sessions than the threshold stays practiced", () => {
  const result = deriveMastery({
    propositions: [node("n1", "Recursion", [{ chatId: "chat-0", messageId: "m" }])],
    chains: [chain("arg_0", ["n1"], "n1", ["chat-0"]), chain("arg_1", ["n1"], "n1", ["chat-1"])],
  });
  assert.equal(result[0]?.level, "practiced");
});

test("aliases map to the same topic as the node name", () => {
  const result = deriveMastery({
    propositions: [node("n1", "JavaScript", [{ chatId: "chat-a", messageId: "m" }], "2026-01-01T00:00:00Z", ["JS", "ECMAScript"])],
    chains: [],
  });
  assert.deepEqual(result.map(m => m.topicId).sort(), ["ecmascript", "javascript", "js"]);
});

test("evidence keeps the earliest timestamp per session and is sorted", () => {
  const result = deriveMastery({
    propositions: [
      node("n1", "Types", [{ chatId: "chat-b", messageId: "m" }], "2026-03-01T00:00:00Z"),
      node("n2", "Types", [{ chatId: "chat-b", messageId: "m2" }], "2026-01-05T00:00:00Z"),
      node("n3", "Types", [{ chatId: "chat-a", messageId: "m" }], "2026-02-01T00:00:00Z"),
    ],
    chains: [],
  });
  assert.deepEqual(result[0]?.evidence, [
    { sessionId: "chat-b", at: "2026-01-05T00:00:00Z" },
    { sessionId: "chat-a", at: "2026-02-01T00:00:00Z" },
  ]);
});

test("nodes without provenance produce no mastery", () => {
  assert.deepEqual(deriveMastery({ propositions: [node("n1", "Loops", [])], chains: [] }), []);
});

test("unknown node ids in a chain are ignored, known ones still count", () => {
  const result = deriveMastery({
    propositions: [node("n1", "Loops", [])],
    chains: [chain("arg_1", ["missing"], "n1", ["chat-a"])],
  });
  assert.deepEqual(result, [{ topicId: "loops", level: "practiced", evidence: [{ sessionId: "chat-a", at: NODE_AT }] }]);
});

test("output is sorted by topic id and deterministic", () => {
  const graph = {
    propositions: [node("n2", "Zeta", [{ chatId: "c", messageId: "m" }]), node("n1", "Alpha", [{ chatId: "c", messageId: "m" }])],
    chains: [],
  };
  assert.deepEqual(deriveMastery(graph).map(m => m.topicId), ["alpha", "zeta"]);
  assert.deepEqual(deriveMastery(graph), deriveMastery(graph));
});

test("readLearnerMap reads the graph exactly once and does not mutate it", () => {
  const graph = {
    propositions: [node("n1", "Arrays", [{ chatId: "chat-a", messageId: "m" }])],
    chains: [],
  };
  const snapshot = structuredClone(graph);
  let reads = 0;
  const result = readLearnerMap({
    graph() {
      reads += 1;
      return graph;
    },
  });
  assert.equal(reads, 1);
  assert.equal(result[0]?.topicId, "arrays");
  assert.deepEqual(graph, snapshot);
});
