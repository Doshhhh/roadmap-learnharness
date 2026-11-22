/** Graph-based roadmap, end to end (issue #16).
 *
 * Synthetic fixtures only: made-up topic names ("Topic 01"...), invented chat ids.
 * The path under test: graph -> brief -> Architect message -> saved draft, and
 * graph count -> empty-state "Build from my graph" button. No model request is made.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphChain, GraphNode } from "learnharness-plugin-api";
import { readGraphTopicCount } from "../src/backend.ts";
import {
  GRAPH_BRIEF_CLOSE,
  GRAPH_BRIEF_MAX_CHARS,
  GRAPH_BRIEF_OPEN,
  quoteGraphBrief,
} from "../src/architect-agent.ts";
import {
  BRIEF_MAX_NAME_CHARS,
  BRIEF_MAX_STATEMENT_CHARS,
  BRIEF_MAX_TOPICS,
  BRIEF_MAX_CHAINS,
  buildGraphBrief,
} from "../src/graph-brief.ts";
import type { BriefGraph, GraphBrief } from "../src/graph-brief.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { rawPath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import { createViewFixture } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

interface ToolResult {
  content: { type: string; text: string }[];
  details: any;
  isError?: boolean;
}

const AT = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const topicName = (n: number) => `Topic ${String(n).padStart(2, "0")}`;
const topicId = (n: number) => `n-${String(n).padStart(2, "0")}`;

function makeTopic(n: number, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: topicId(n),
    name: topicName(n),
    statement: `${topicName(n)} is a made-up fact for tests.`,
    aliases: [],
    createdAt: AT(n),
    provenance: [{ chatId: `chat-${(n % 3) + 1}`, messageId: `m-${n}` }],
    ...overrides,
  };
}

function makeChain(id: string, premises: string[], conclusion: string, minute: number): GraphChain {
  return { id, premises, conclusion, provenance: [{ chatId: "chat-1", messageId: "m-chain" }], createdAt: AT(minute) };
}

/** `topics` made-up topics, and `chains` chains of two premises each leading to the next topic along. */
function syntheticGraph(topics: number, chains: number): BriefGraph {
  const propositions = Array.from({ length: topics }, (_, index) => makeTopic(index + 1));
  const built = Array.from({ length: chains }, (_, index) => {
    const first = (index % (topics - 2)) + 1;
    return makeChain(`arg-${index + 1}`, [topicId(first), topicId(first + 1)], topicId(first + 2), topics + index + 1);
  });
  return { propositions, chains: built } as BriefGraph;
}

/** The fixture used by most tests: 36 topics, 34 valid chains, one alias, one chain that points at a missing topic. */
const FIXTURE: BriefGraph = (() => {
  const base = syntheticGraph(36, 34);
  const propositions = [
    ...base.propositions.slice(0, 35),
    makeTopic(36, { aliases: ["Topic Thirty Six"] }),
  ];
  const dangling = makeChain("arg-dangling", [topicId(1)], "n-missing", 200);
  return { propositions, chains: [...base.chains, dangling] } as BriefGraph;
})();

const EMPTY_GRAPH = { propositions: [], chains: [] } as BriefGraph;

function host(t: { after: (fn: () => void) => void }, graph?: BriefGraph): TestHost {
  const created = createHost(graph ? { graph } : {});
  t.after(() => created.close());
  return created;
}

/** The text between the brief markers, parsed as the JSON the model is sent. */
function quotedBody(message: string): any {
  const start = message.indexOf(GRAPH_BRIEF_OPEN);
  const end = message.indexOf(GRAPH_BRIEF_CLOSE);
  assert.ok(start >= 0 && end > start, "the brief is quoted between the markers");
  return JSON.parse(message.slice(start + GRAPH_BRIEF_OPEN.length, end));
}

/** Create an Architect conversation, send one message, and return the text the model is sent. */
async function sentText(h: TestHost, learnerGraph: boolean | undefined, text = "Build my roadmap") {
  const { conversation } = await h.call<{ conversation: { id: string } }>("architect.create");
  await h.call("architect.send", {
    id: conversation.id,
    text,
    requestId: `req-${conversation.id}`,
    ...(learnerGraph === undefined ? {} : { learnerGraph }),
  });
  const { conversation: current } = await h.call<{ conversation: { messages: { content: string }[] } }>("architect.get", {
    id: conversation.id,
  });
  return { conversation, content: current.messages.at(0)?.content ?? "" };
}

/** Send with the brief, then save the draft through the Architect's own tool and read the stored path back. */
async function draftThroughBrief(h: TestHost, draft: any, learnerGraph: boolean) {
  const { conversation } = await h.call<{ conversation: { id: string } }>("architect.create");
  await h.call("architect.send", {
    id: conversation.id,
    text: "Build my roadmap",
    requestId: `req-draft-${conversation.id}`,
    learnerGraph,
  });
  const saved = await h.runTool<ToolResult>("save_learning_path", draft);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  const { path } = await h.call<{ path: any }>("paths.get", { id: draft.id });
  return path;
}

const nodesOf = (path: any): any[] => path.modules.flatMap((module: any) => module.nodes);

async function mountEmpty(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  await fixture.flush();
  return container;
}

// ---------------------------------------------------------------------------
// 1. The fixture and the brief built from it
// ---------------------------------------------------------------------------

test("the synthetic fixture is a few dozen topics and chains with made-up names", () => {
  assert.equal(FIXTURE.propositions.length, 36);
  assert.equal(FIXTURE.chains.length, 35, "34 valid chains plus one dangling chain");
  for (const node of FIXTURE.propositions) assert.match(node.name, /^Topic /, "names are made up");
});

test("the brief from the fixture is built and its counts match", () => {
  const brief = buildGraphBrief(FIXTURE);
  assert.deepEqual(brief.counts, { topics: 36, chains: 34, droppedTopics: 0, droppedChains: 0 });
  assert.equal(brief.topics.length, 36);
  assert.equal(brief.chains.length, 34, "the chain pointing at a missing topic is not in the brief");
  assert.deepEqual(brief.topics.map((topic) => topic.name), Array.from({ length: 36 }, (_, i) => topicName(i + 1)));
  assert.deepEqual(brief.topics[35]?.aliases, ["Topic Thirty Six"]);
  assert.deepEqual(brief.chains[0], { premises: ["Topic 01", "Topic 02"], conclusion: "Topic 03" });
});

test("the brief does not depend on the order the graph arrays come in", () => {
  const shuffled: BriefGraph = {
    propositions: [...FIXTURE.propositions].reverse(),
    chains: [...FIXTURE.chains].reverse(),
  } as BriefGraph;
  assert.deepEqual(buildGraphBrief(shuffled), buildGraphBrief(FIXTURE));
});

test("the backend topic count and the Architect message both come from the same fixture brief", async (t) => {
  const h = host(t, FIXTURE);
  const { topics } = await h.call<{ topics: number }>("graph.topicCount");
  assert.equal(topics, 36);
  assert.equal(readGraphTopicCount({ graph: () => FIXTURE }), 36);

  const { content } = await sentText(h, true);
  assert.ok(content.startsWith("Context: the learner's Knowledge Graph"));
  const quoted = quotedBody(content);
  assert.equal(quoted.topics.length, 36, "every fixture topic fits under the prompt cap");
  assert.equal(quoted.chains.length, 34);
  assert.deepEqual(quoted, JSON.parse(quoteGraphBrief(buildGraphBrief(FIXTURE))));
});

test("a large fixture is capped in the brief: counts say what was left out", () => {
  const large = syntheticGraph(75, 70);
  const brief = buildGraphBrief(large);
  assert.deepEqual(brief.counts, {
    topics: 75,
    chains: 70,
    droppedTopics: 75 - BRIEF_MAX_TOPICS,
    droppedChains: 70 - BRIEF_MAX_CHAINS,
  });
  assert.equal(brief.topics.length, BRIEF_MAX_TOPICS);
  assert.equal(brief.chains.length, BRIEF_MAX_CHAINS);
  assert.deepEqual(brief.topics[0]?.name, "Topic 01", "the first topics in createdAt order are the ones kept");
});

test("a large fixture is capped in the quoted prompt text", async (t) => {
  const large = syntheticGraph(75, 70);
  const h = host(t, large);
  const { content } = await sentText(h, true);
  const quoted = quotedBody(content);
  const body = content.slice(content.indexOf(GRAPH_BRIEF_OPEN) + GRAPH_BRIEF_OPEN.length, content.indexOf(GRAPH_BRIEF_CLOSE));
  assert.ok(body.length <= GRAPH_BRIEF_MAX_CHARS, `the quoted data stays within ${GRAPH_BRIEF_MAX_CHARS} characters`);
  assert.ok(quoted.chains.length < BRIEF_MAX_CHAINS, "the cap drops the last chains first");
  assert.ok(quoted.topics.length > 0, "the cap keeps some topics");
  const kept = buildGraphBrief(large).topics.slice(0, quoted.topics.length).map((topic) => topic.name);
  assert.deepEqual(quoted.topics.map((topic: { name: string }) => topic.name), kept, "the kept topics are a prefix, in order");
});

// ---------------------------------------------------------------------------
// 2. A very long statement
// ---------------------------------------------------------------------------

test("a very long statement is capped in the brief", () => {
  const long = "lorem ipsum ".repeat(1_000);
  const longName = "N".repeat(500);
  const graph = {
    propositions: [makeTopic(1, { statement: long, name: longName }), makeTopic(2)],
    chains: [],
  } as BriefGraph;
  const brief = buildGraphBrief(graph);
  const [first] = brief.topics;
  assert.ok(first);
  assert.equal(first.statement.length, BRIEF_MAX_STATEMENT_CHARS);
  assert.ok(first.statement.endsWith("…"), "a cut statement ends with an ellipsis");
  assert.equal(first.name.length, BRIEF_MAX_NAME_CHARS);
  assert.equal(brief.topics[1]?.statement, topicName(2) + " is a made-up fact for tests.", "short statements are kept whole");
});

test("a very long statement is capped in the quoted prompt text", async (t) => {
  const long = "lorem ipsum ".repeat(1_000);
  const h = host(t, { propositions: [makeTopic(1, { statement: long })], chains: [] } as BriefGraph);
  const { content } = await sentText(h, true);
  assert.ok(content.length < long.length, "the full statement is not sent");
  const quoted = quotedBody(content);
  assert.equal(quoted.topics[0].statement.length, BRIEF_MAX_STATEMENT_CHARS);
  const occurrences = content.split("lorem ipsum").length - 1;
  assert.ok(occurrences <= Math.ceil(BRIEF_MAX_STATEMENT_CHARS / "lorem ipsum ".length), `only the capped part is quoted (${occurrences})`);
});

test("quoting a brief with an oversized statement still respects the cap", () => {
  const brief: GraphBrief = {
    topics: [{ name: "Topic 01", statement: "y".repeat(20_000), aliases: [], sourceChatIds: ["chat-1"] }],
    chains: [],
    counts: { topics: 1, chains: 0, droppedTopics: 0, droppedChains: 0 },
  };
  const quoted = quoteGraphBrief(brief);
  assert.ok(quoted.length <= GRAPH_BRIEF_MAX_CHARS, "the quoted brief is capped even when a single topic is oversized");
  assert.deepEqual(JSON.parse(quoted).topics, [], "the oversized topic is dropped rather than sent whole");
});

// ---------------------------------------------------------------------------
// 3. Draft with the brief
// ---------------------------------------------------------------------------

/** rawPath with three draft nodes retitled: one matched by name, one matched by alias, one unknown to the graph. */
function draftWithGraphTitles(): any {
  const draft = rawPath();
  const [holistic, concept] = draft.modules[0].nodes;
  const checkpoint = draft.modules[1].nodes[1];
  holistic.title = topicName(3); // matched by name; the model marks it consolidated
  holistic.progression = "consolidated";
  concept.title = "Topic Thirty Six"; // matched by the alias of Topic 36; the model marks it consolidated
  concept.progression = "consolidated";
  checkpoint.title = "Unmatched Goal Node"; // not in the graph; the model marks it consolidated
  checkpoint.progression = "consolidated";
  return draft;
}

test("a draft with the brief: matched nodes are optional, none is consolidated, an unmatched node is unaffected", async (t) => {
  const draft = draftWithGraphTitles();
  const [holisticId, conceptId, checkpointId] = [draft.modules[0].nodes[0].id, draft.modules[0].nodes[1].id, draft.modules[1].nodes[1].id];
  const h = host(t, FIXTURE);
  const path = await draftThroughBrief(h, draft, true);
  const stored = new Map<string, any>(nodesOf(path).map((node) => [node.id, node]));

  assert.equal(stored.get(holisticId).optional, true, "a node matched by name is optional review");
  assert.equal(stored.get(holisticId).progression, "unstarted", "and not consolidated");
  assert.equal(stored.get(conceptId).optional, true, "a node matched by alias is optional review");
  assert.equal(stored.get(conceptId).progression, "unstarted");

  assert.notEqual(stored.get(checkpointId).optional, true, "an unmatched node is not marked optional");
  assert.equal(stored.get(checkpointId).progression, "consolidated", "an unmatched node keeps the model's progression");

  const optional = nodesOf(path).filter((node) => node.optional === true);
  assert.equal(optional.length, 2);
  assert.ok(optional.every((node) => node.progression !== "consolidated"), "nothing optional is consolidated");
});

test("the same draft without the brief is not changed by the graph", async (t) => {
  const withoutBrief = await draftThroughBrief(host(t, FIXTURE), draftWithGraphTitles(), false);
  const nodes = nodesOf(withoutBrief);
  assert.ok(nodes.every((node) => node.optional !== true), "no node is marked optional without the brief");
  const holistic = nodes.find((node) => node.title === topicName(3));
  assert.equal(holistic?.progression, "consolidated", "the model's own progression is kept without the brief");
});

// ---------------------------------------------------------------------------
// 4. Empty-state button
// ---------------------------------------------------------------------------

test("the 'Build from my graph' button is enabled when the fixture graph has topics", async (t) => {
  const h = host(t, FIXTURE);
  const { topics } = await h.call<{ topics: number }>("graph.topicCount");
  const fixture = createViewFixture({ paths: [], graphTopics: topics });
  try {
    const container = await mountEmpty(fixture);
    const build = container.querySelector<HTMLButtonElement>(".rm-empty-build");
    assert.ok(build, "the empty state offers the button");
    assert.equal(build.textContent, "Build from my graph");
    assert.equal(build.disabled, false);
    assert.equal(container.querySelector(".rm-empty-hint"), null, "no hint when the button works");
  } finally {
    fixture.controller.abort();
  }
});

test("the 'Build from my graph' button is disabled with an empty fixture graph, and says why", async (t) => {
  const h = host(t, EMPTY_GRAPH);
  const { topics } = await h.call<{ topics: number }>("graph.topicCount");
  assert.equal(topics, 0);
  const fixture = createViewFixture({ paths: [], graphTopics: topics });
  try {
    const container = await mountEmpty(fixture);
    const build = container.querySelector<HTMLButtonElement>(".rm-empty-build");
    assert.ok(build, "the empty state still offers the button");
    assert.equal(build.disabled, true);
    assert.ok(container.querySelector(".rm-empty-hint")?.textContent?.includes("no topics"), "a hint explains the disabled button");
  } finally {
    fixture.controller.abort();
  }
});
