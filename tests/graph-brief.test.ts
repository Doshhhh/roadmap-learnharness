import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphChain, GraphNode } from "learnharness-plugin-api";
import {
  BRIEF_MAX_ALIASES,
  BRIEF_MAX_CHAINS,
  BRIEF_MAX_NAME_CHARS,
  BRIEF_MAX_STATEMENT_CHARS,
  BRIEF_MAX_TOPICS,
  buildGraphBrief,
} from "../src/graph-brief.ts";

// Synthetic fixture only: invented topics, invented chat ids.
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const T2 = "2026-01-03T00:00:00Z";

function topic(
  id: string,
  name: string,
  createdAt: string,
  chatIds: string[] = ["chat-a"],
  aliases: string[] = [],
  statement = `${name} is a made-up fact.`,
): GraphNode {
  return {
    id,
    name,
    statement,
    aliases,
    createdAt,
    provenance: chatIds.map(chatId => ({ chatId, messageId: "m1" })),
  };
}

function chain(id: string, premises: string[], conclusion: string, createdAt: string): GraphChain {
  return { id, premises, conclusion, provenance: [{ chatId: "chat-a", messageId: "m2" }], createdAt };
}

/** A projection with the same shape as GraphSnapshot; only propositions and chains are read. */
function snapshot(propositions: GraphNode[], chains: GraphChain[]) {
  return { propositions, chains, nodes: propositions, edges: [], logicalEdges: [], impLinks: [], sessions: {}, fileSources: {}, nodeSessions: {}, clusters: [] };
}

const FIXTURE = snapshot(
  [
    topic("n_3", "Alpha", T2, ["chat-b", "chat-a"], ["alpha alias", "ALPHA alias"]),
    topic("n_1", "Beta", T0, ["chat-a"], ["beta words"]),
    topic("n_2", "Gamma", T1, ["chat-c"]),
  ],
  [
    chain("arg_2", ["n_1", "n_2"], "n_3", T2),
    chain("arg_1", ["n_1"], "n_2", T1),
  ],
);

test("a normal graph becomes a brief sorted by createdAt then id", () => {
  const brief = buildGraphBrief(FIXTURE);
  assert.deepEqual(
    brief.topics.map(t => t.name),
    ["Beta", "Gamma", "Alpha"],
  );
  assert.deepEqual(brief.topics[2], {
    name: "Alpha",
    statement: "Alpha is a made-up fact.",
    aliases: ["ALPHA alias", "alpha alias"],
    sourceChatIds: ["chat-a", "chat-b"],
  });
  assert.deepEqual(brief.chains, [
    { premises: ["Beta"], conclusion: "Gamma" },
    { premises: ["Beta", "Gamma"], conclusion: "Alpha" },
  ]);
  assert.deepEqual(brief.counts, { topics: 3, chains: 2, droppedTopics: 0, droppedChains: 0 });
});

test("an empty graph returns an empty brief with zero counts", () => {
  assert.deepEqual(buildGraphBrief(snapshot([], [])), {
    topics: [],
    chains: [],
    counts: { topics: 0, chains: 0, droppedTopics: 0, droppedChains: 0 },
  });
});

test("chains that mention unknown propositions are not counted or listed", () => {
  const brief = buildGraphBrief(
    snapshot([topic("n_1", "Beta", T0)], [chain("arg_x", ["n_1", "n_missing"], "n_1", T1)]),
  );
  assert.deepEqual(brief.chains, []);
  assert.equal(brief.counts.chains, 0);
});

test("long names, statements and aliases are clipped with an ellipsis", () => {
  const longName = "N".repeat(BRIEF_MAX_NAME_CHARS + 50);
  const longStatement = `word   ${"s".repeat(BRIEF_MAX_STATEMENT_CHARS * 2)}`;
  const aliases = Array.from({ length: BRIEF_MAX_ALIASES + 4 }, (_, i) => `alias ${String(i).padStart(2, "0")}`);
  const [t] = buildGraphBrief(snapshot([topic("n_1", longName, T0, ["chat-a"], aliases, longStatement)], [])).topics;
  assert.ok(t);
  assert.equal(t.name.length, BRIEF_MAX_NAME_CHARS);
  assert.ok(t.name.endsWith("…"));
  assert.equal(t.statement.length, BRIEF_MAX_STATEMENT_CHARS);
  assert.ok(t.statement.startsWith("word s"));
  assert.ok(t.statement.endsWith("…"));
  assert.equal(t.aliases.length, BRIEF_MAX_ALIASES);
});

test("too many topics and chains are capped and counted as dropped", () => {
  const total = BRIEF_MAX_TOPICS + 7;
  const propositions = Array.from({ length: total }, (_, i) =>
    topic(`n_${String(i).padStart(3, "0")}`, `Topic ${i}`, T0),
  );
  // One chain per topic pair (i, i+1): total - 1 chains, more than the cap.
  const chains = Array.from({ length: total - 1 }, (_, i) =>
    chain(`arg_${String(i).padStart(3, "0")}`, [propositions[i]!.id], propositions[i + 1]!.id, T1),
  );
  const brief = buildGraphBrief(snapshot(propositions, chains));
  assert.equal(brief.topics.length, BRIEF_MAX_TOPICS);
  assert.equal(brief.chains.length, BRIEF_MAX_CHAINS);
  assert.deepEqual(brief.counts, {
    topics: total,
    chains: total - 1,
    droppedTopics: 7,
    droppedChains: total - 1 - BRIEF_MAX_CHAINS,
  });
  assert.equal(brief.topics[0]?.name, "Topic 0");
});

test("the same graph gives the same brief regardless of input order", () => {
  const reversed = snapshot([...FIXTURE.propositions].reverse(), [...FIXTURE.chains].reverse());
  const shuffledPremises = snapshot(FIXTURE.propositions, [
    chain("arg_2", ["n_2", "n_1"], "n_3", T2),
    chain("arg_1", ["n_1"], "n_2", T1),
  ]);
  const expected = buildGraphBrief(FIXTURE);
  assert.deepEqual(buildGraphBrief(reversed), expected);
  assert.deepEqual(buildGraphBrief(shuffledPremises), expected);
});

test("ties on createdAt are broken by id", () => {
  const brief = buildGraphBrief(
    snapshot([topic("n_b", "Second", T0), topic("n_a", "First", T0)], []),
  );
  assert.deepEqual(brief.topics.map(t => t.name), ["First", "Second"]);
});

test("the brief does not mutate the snapshot it reads", () => {
  const before = JSON.stringify(FIXTURE);
  buildGraphBrief(FIXTURE);
  assert.equal(JSON.stringify(FIXTURE), before);
});
