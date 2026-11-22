import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { test } from "node:test";
import { openLearningPathStore } from "../src/store.ts";
import { createNodeInspector } from "../src/view/node-inspector.ts";
import { propositionsForChats } from "../src/node-propositions.ts";
import type { NodeProposition, PropositionSource } from "../src/node-propositions.ts";
import { makeNode, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import { buttonByText } from "./roadmap-dom.ts";
import { createViewFixture } from "./view-host.ts";

const graph: PropositionSource[] = [
  { id: "p1", name: "Hash", statement: "A hash maps keys to slots.", provenance: [{ chatId: "chat-a" }] },
  { id: "p2", name: "Collision", statement: "Two keys can share a slot.", provenance: [{ chatId: "chat-b" }, { chatId: "chat-a" }] },
  { id: "p3", name: "Heap", statement: "A heap orders by priority.", provenance: [{ chatId: "chat-c" }] },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("propositionsForChats keeps propositions with provenance in the given chats, in graph order", () => {
  const found: NodeProposition[] = propositionsForChats(["chat-a"], graph);
  assert.deepEqual(found.map((entry) => entry.id), ["p1", "p2"]);
  assert.deepEqual(Object.keys(found[0]!).sort(), ["id", "name", "statement"], "only the panel fields are returned");
});

test("propositionsForChats returns nothing for a node without linked chats", () => {
  assert.deepEqual(propositionsForChats([], graph), []);
  assert.deepEqual(propositionsForChats(["chat-z"], graph), []);
});

function mountSeed(seed: boolean, found: readonly NodeProposition[] | null) {
  const fixture = createViewFixture();
  const node = makeNode("n-hash", "skill", {
    childSessions: [{ chatId: "chat-a", kind: "teaching", createdAt: "2026-03-01T10:00:00Z", label: "Hashing" }],
    artifactConfig: { type: seed ? "retrieval_cue" : "none" },
  });
  const base = makePath();
  const path = { ...base, modules: base.modules.map((module, index) => (index === 0 ? { ...module, nodes: [...module.nodes, node] } : module)) };
  const asked: string[] = [];
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
    nodePropositions: async (target) => {
      asked.push(target.id);
      return found;
    },
  });
  return { fixture, path, node, inspector, asked };
}

test("the Flashcard seed action shows the node's graph propositions and says where the review is", async () => {
  const { fixture, path, node, inspector, asked } = mountSeed(true, propositionsForChats(["chat-a"], graph));
  try {
    inspector.render(path, node);
    buttonByText(fixture.root, "Show facts from your Knowledge Graph").click();
    await settle();
    assert.deepEqual(asked, ["n-hash"]);
    const text = fixture.root.textContent ?? "";
    assert.match(text, /Knowledge Graph facts for this node/);
    assert.match(text, /Hash/);
    assert.match(text, /Two keys can share a slot\./);
    assert.match(text, /If the Flashcards plugin is installed/);
    assert.match(text, /cannot open that view or check whether the plugin is installed/);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("with no linked propositions the action says so instead of failing", async () => {
  const { fixture, path, node, inspector } = mountSeed(true, []);
  try {
    inspector.render(path, node);
    buttonByText(fixture.root, "Show facts from your Knowledge Graph").click();
    await settle();
    assert.match(fixture.root.textContent ?? "", /No Knowledge Graph facts are linked to this node yet/);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("a failed graph read shows a plain message", async () => {
  const { fixture, path, node, inspector } = mountSeed(true, null);
  try {
    inspector.render(path, node);
    buttonByText(fixture.root, "Show facts from your Knowledge Graph").click();
    await settle();
    assert.match(fixture.root.textContent ?? "", /could not be read right now/);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("the action is offered only for the Flashcard seed artifact", () => {
  const { fixture, path, node, inspector } = mountSeed(false, []);
  try {
    inspector.render(path, node);
    const labels = [...fixture.root.querySelectorAll("button")].map((button) => button.textContent);
    assert.equal(labels.includes("Show facts from your Knowledge Graph"), false);
  } finally {
    inspector.dispose();
    fixture.restore();
  }
});

test("graph.propositions returns only the stored node's propositions and changes nothing", async (t) => {
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "roadmap-propositions-"));
  const link = (chatId: string) => ({ chatId, kind: "teaching" as const, createdAt: "2026-03-01T10:00:00Z", label: chatId });
  const seed = makeNode("n-hash", "skill", { childSessions: [link("chat-a")], artifactConfig: { type: "retrieval_cue" } });
  const other = makeNode("n-heap", "skill", { childSessions: [link("chat-c")] });
  const base = makePath();
  openLearningPathStore(directory).savePath({ ...base, modules: [{ ...base.modules[0]!, nodes: [seed, other] }] });
  const stored = structuredClone({ propositions: graph, chains: [] });
  const host = createHost({ dataDirectory: directory, graph: stored });
  t.after(() => {
    host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const before = fs.readdirSync(directory, { recursive: true }).map(String).sort()
    .map((file) => [file, fs.statSync(nodePath.join(directory, file)).isFile() ? fs.readFileSync(nodePath.join(directory, file), "utf8") : ""]);

  const { propositions } = await host.call<{ propositions: NodeProposition[] }>("graph.propositions", {
    pathId: base.id,
    nodeId: "n-hash",
    chatIds: ["chat-c"],
  });

  assert.deepEqual(propositions.map((entry) => entry.id), ["p1", "p2"], "only the node's own chats count; caller chat ids are ignored");
  assert.deepEqual(stored, { propositions: graph, chains: [] }, "the graph is only read");
  const after = fs.readdirSync(directory, { recursive: true }).map(String).sort()
    .map((file) => [file, fs.statSync(nodePath.join(directory, file)).isFile() ? fs.readFileSync(nodePath.join(directory, file), "utf8") : ""]);
  assert.deepEqual(after, before, "no roadmap file, including the stored artifact value, is written");
  await assert.rejects(() => host.call("graph.propositions", { pathId: base.id, nodeId: "missing" }), /Unknown node/);
});
