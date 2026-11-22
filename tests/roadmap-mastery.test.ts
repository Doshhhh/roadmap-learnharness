/** Roadmap view gets Knowledge Graph mastery (fix for the gap in issues #8 and #9). Synthetic data only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphChain, GraphNode } from "learnharness-plugin-api";
import { readGraphMastery } from "../src/backend.ts";
import type { LearningPath, PathNode } from "../src/domain.ts";
import type { Mastery } from "../src/learner-map.ts";
import { nextUpForPath } from "../src/node-next.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import { selectNode } from "./roadmap-dom.ts";
import { createViewFixture } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

const AT = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const topic = (id: string, name: string): GraphNode => ({
  id,
  name,
  statement: `${name} is a made-up fact.`,
  aliases: [],
  createdAt: AT(1),
  provenance: [{ chatId: "chat-1", messageId: `m-${id}` }],
});

const chain = (id: string, premise: string, conclusion: string, chatId: string, minute: number): GraphChain => ({
  id,
  premises: [premise],
  conclusion,
  provenance: [{ chatId, messageId: `m-${id}` }],
  createdAt: AT(minute),
});

/** "Topic Alpha" is stored once and used as a premise in three sessions; "Topic Beta" is only stored. */
const SYNTHETIC_GRAPH = {
  propositions: [topic("n-alpha", "Topic Alpha"), topic("n-beta", "Topic Beta"), topic("n-gamma", "Topic Gamma")],
  chains: [
    chain("c-1", "n-alpha", "n-gamma", "chat-2", 10),
    chain("c-2", "n-alpha", "n-gamma", "chat-3", 20),
    chain("c-3", "n-alpha", "n-gamma", "chat-4", 30),
  ],
};

function pathWith(nodes: PathNode[]): LearningPath {
  const base = makePath();
  return { ...base, modules: [{ ...base.modules[0]!, nodes }] };
}

/** Alpha depends on nothing; Beta follows Alpha in module order, so Alpha blocks one node. */
function twoNodePath(): LearningPath {
  return pathWith([
    makeNode("node-alpha", "concept", { title: "Alpha", catalogTopic: { roadmap: "linear-algebra", slug: "alpha-topic" } }),
    makeNode("node-beta", "concept", { title: "Beta" }),
  ]);
}

const alphaPracticed: Mastery = {
  topicId: "alpha-topic",
  level: "practiced",
  evidence: [{ sessionId: "s1", at: "2026-03-01T10:00:00Z" }],
};

async function mountHub(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  for (let i = 0; i < 3; i += 1) await fixture.flush();
  return container;
}

function nextWhy(container: HTMLElement): string {
  return [...container.querySelectorAll(".rm-status-next-why")].map(node => node.textContent ?? "").join(" | ");
}

test("graph.mastery returns mastery derived from the synthetic graph and does not change it", async (t) => {
  const host = createHost({ graph: structuredClone(SYNTHETIC_GRAPH) });
  t.after(() => host.close());
  const before = structuredClone(SYNTHETIC_GRAPH);

  const { mastery } = await host.call<{ mastery: Mastery[] }>("graph.mastery");

  const alpha = mastery.find(entry => entry.topicId === "topic-alpha");
  assert.ok(alpha, "the practiced topic is returned");
  assert.equal(alpha.level, "mastered", "three practice sessions make it mastered");
  assert.deepEqual(alpha.evidence.map(entry => entry.sessionId), ["chat-1", "chat-2", "chat-3", "chat-4"], "the stored sighting counts as seen");
  assert.ok(mastery.some(entry => entry.topicId === "topic-beta" && entry.level === "seen"));
  assert.deepEqual(SYNTHETIC_GRAPH, before, "the RPC only reads the graph");
});

test("readGraphMastery treats a graph without arrays as having no mastery", () => {
  assert.deepEqual(readGraphMastery({ graph: () => ({}) as never }), []);
});

test("a failing mastery read gives no evidence and no next-up list", async (t) => {
  const fixture = createViewFixture({ paths: [twoNodePath()], masteryFails: true });
  t.after(() => fixture.controller.abort());
  const container = await mountHub(fixture);
  await selectNode(fixture, "node-alpha");

  assert.ok(fixture.calls.some(call => call.name === "graph.mastery"), "the view asks for mastery");
  assert.doesNotMatch(container.textContent ?? "", /Studied elsewhere/);
  const next = container.querySelector<HTMLElement>(".rm-status-next");
  assert.equal(next?.hidden, true, "no ranking is shown on a failed read");
  assert.doesNotMatch(nextWhy(container), /Downstream nodes it blocks/);
});

test("a matched catalog topic with practiced mastery shows the evidence block in the node panel", async (t) => {
  const fixture = createViewFixture({ paths: [twoNodePath()], mastery: [alphaPracticed] });
  t.after(() => fixture.controller.abort());
  const container = await mountHub(fixture);
  await selectNode(fixture, "node-alpha");

  const text = container.textContent ?? "";
  assert.match(text, /Studied elsewhere/);
  assert.match(text, /practiced/);
});

test("the next-up ranking uses the mastery the view received", async (t) => {
  const path = twoNodePath();
  const withoutMastery = nextUpForPath(path);
  const withMastery = nextUpForPath(path, undefined, [alphaPracticed]);
  assert.equal(withoutMastery[0]?.nodeId, "node-alpha");
  assert.equal(withMastery[0]?.nodeId, "node-alpha");
  assert.ok(withoutMastery[0]?.reasons.some(reason => reason.key === "next.blocks"), "unseen Alpha blocks Beta");
  assert.ok(!withMastery[0]?.reasons.some(reason => reason.key === "next.blocks"), "practiced Alpha blocks nothing");

  const fixture = createViewFixture({ paths: [path], mastery: [alphaPracticed] });
  t.after(() => fixture.controller.abort());
  const container = await mountHub(fixture);
  assert.doesNotMatch(nextWhy(container), /Downstream nodes it blocks/, "the view shows the mastery-based ranking");
  assert.match(nextWhy(container), /No required prerequisites/);
});
