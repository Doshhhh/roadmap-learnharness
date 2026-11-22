import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogView } from "../src/catalog-match.ts";
import {
  linkNodeToTopic,
  nodePrerequisites,
  scoreTopics,
  significantWords,
  type EdgeCatalogView,
  type LinkPick,
  type LinkedNode,
  type LinkRerank,
} from "../src/node-catalog-link.ts";

// Word-overlap fixture: "closures", "javascript" and "html" overlap the node text; the backend
// JavaScript topic duplicates the frontend one so ties can be exercised.
const catalog: CatalogView = {
  roadmaps: [
    {
      slug: "frontend",
      title: "Frontend",
      topics: [
        { slug: "html", title: "HTML" },
        { slug: "css", title: "CSS" },
        { slug: "javascript", title: "JavaScript" },
        { slug: "closures", title: "Closures" },
      ],
    },
    {
      slug: "backend",
      title: "Backend",
      topics: [
        { slug: "javascript", title: "JavaScript" },
        { slug: "sql", title: "SQL" },
        { slug: "http-servers", title: "HTTP servers" },
      ],
    },
    {
      slug: "ai-agents",
      title: "AI agents",
      topics: [
        { slug: "agent-loop", title: "Agent loop" },
        { slug: "anthropic-tool-use", title: "Anthropic tool use" },
      ],
    },
  ],
};

const noMatch = { title: "Cooking pasta", goal: "Boil water and salt it." };

test("significant words drop short tokens and stopwords and fold plurals", () => {
  assert.deepEqual([...significantWords("The Closures of JavaScript, and the Tools")].sort(), [
    "closure",
    "javascript",
    "tool",
  ]);
});

test("a topic is scored by the share of its words the node covers, and weak overlaps are omitted", () => {
  const scored = scoreTopics({ title: "Closures", goal: "How closures capture variables" }, catalog);
  assert.deepEqual(scored.map((candidate) => `${candidate.roadmap}/${candidate.slug}`), ["frontend/closures"]);
  assert.equal(scored[0]!.score, 1);

  // "agent" covers half of "Agent loop", below the threshold.
  assert.deepEqual(scoreTopics({ title: "Agent design", goal: "Plan agents" }, catalog), []);
});

test("links a node to the one topic its title and goal clearly cover, deterministically", async () => {
  const result = await linkNodeToTopic({ title: "Closures", goal: "How closures capture variables" }, catalog);
  assert.deepEqual(result.proposal?.link, { roadmap: "frontend", slug: "closures" });
  assert.equal(result.proposal?.source, "deterministic");
  assert.equal(result.proposal?.title, "Closures");
  assert.equal(result.modelOutcome, "not-called");
});

test("outcomes count as node evidence", async () => {
  const result = await linkNodeToTopic(
    { title: "Web fundamentals", goal: "Background", outcomes: ["Write HTTP servers in Node"] },
    catalog,
  );
  assert.deepEqual(result.proposal?.link, { roadmap: "backend", slug: "http-servers" });
});

test("never guesses: no overlap, and no clear winner, give no proposal", async () => {
  const none = await linkNodeToTopic(noMatch, catalog);
  assert.equal(none.proposal, null);
  assert.deepEqual(none.candidates, []);

  // "JavaScript" is in both the frontend and backend roadmaps with equal scores: a tie.
  const tied = await linkNodeToTopic({ title: "JavaScript basics", goal: "Scripts" }, catalog);
  assert.equal(tied.proposal, null);
  assert.equal(tied.candidates.length, 2);
});

test("a model pick that is a real candidate breaks a tie and is marked as the model's", async () => {
  const rerank: LinkRerank = async (_node, candidates) => {
    assert.equal(candidates.length, 2);
    return { roadmap: "backend", slug: "javascript", reason: "The node is about server-side scripts." };
  };
  const result = await linkNodeToTopic({ title: "JavaScript basics", goal: "Scripts" }, catalog, { rerank });
  assert.deepEqual(result.proposal?.link, { roadmap: "backend", slug: "javascript" });
  assert.equal(result.proposal?.source, "model");
  assert.equal(result.proposal?.reason, "The node is about server-side scripts.");
  assert.equal(result.modelOutcome, "accepted");
});

test("a model answer that is not a candidate falls back to the deterministic result", async () => {
  const pick: LinkPick = { roadmap: "frontend", slug: "sql", reason: "Looks related." };
  const rerank: LinkRerank = async () => pick;
  // The deterministic winner is closures; "frontend/sql" is a real topic but not a candidate.
  const result = await linkNodeToTopic(
    { title: "Closures", goal: "How closures capture variables" },
    catalog,
    { rerank },
  );
  assert.equal(result.modelOutcome, "invalid");
  assert.deepEqual(result.proposal?.link, { roadmap: "frontend", slug: "closures" });
  assert.equal(result.proposal?.source, "deterministic");
});

test("an invalid model answer on a tie leaves the node unlinked", async () => {
  const rerank: LinkRerank = async () => ({ roadmap: "backend", slug: "invented", reason: "Made up." });
  const result = await linkNodeToTopic({ title: "JavaScript basics", goal: "Scripts" }, catalog, { rerank });
  assert.equal(result.proposal, null);
  assert.equal(result.modelOutcome, "invalid");
});

test("an empty reason, a null answer and a thrown error are not model answers", async () => {
  const node = { title: "Closures", goal: "How closures capture variables" };
  const emptyReason = await linkNodeToTopic(node, catalog, {
    rerank: async () => ({ roadmap: "frontend", slug: "closures", reason: "   " }),
  });
  assert.equal(emptyReason.modelOutcome, "invalid");

  const nullAnswer = await linkNodeToTopic(node, catalog, { rerank: async () => null });
  assert.equal(nullAnswer.modelOutcome, "failed");
  assert.deepEqual(nullAnswer.proposal?.link, { roadmap: "frontend", slug: "closures" });

  const thrown = await linkNodeToTopic(node, catalog, {
    rerank: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(thrown.modelOutcome, "failed");
  assert.deepEqual(thrown.proposal?.link, { roadmap: "frontend", slug: "closures" });
});

test("the model is not called when nothing clears the threshold", async () => {
  let calls = 0;
  const result = await linkNodeToTopic(noMatch, catalog, {
    rerank: async () => {
      calls += 1;
      return null;
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.proposal, null);
  assert.equal(result.modelOutcome, "not-called");
});

// Prerequisite fixture: frontend has real catalog edges (javascript needs html and css, closures
// needs javascript). Backend javascript has none.
const edgeCatalog: EdgeCatalogView = {
  roadmaps: [
    {
      slug: "frontend",
      topics: [
        { slug: "html", prerequisites: [] },
        { slug: "css", prerequisites: [] },
        { slug: "javascript", prerequisites: ["html", "css"] },
        { slug: "closures", prerequisites: ["javascript"] },
      ],
    },
    {
      slug: "backend",
      topics: [{ slug: "javascript", prerequisites: [] }],
    },
  ],
};

const pathNodes: LinkedNode[] = [
  { id: "n-html", catalogTopic: { roadmap: "frontend", slug: "html" } },
  { id: "n-css", catalogTopic: { roadmap: "frontend", slug: "css" } },
  { id: "n-js", catalogTopic: { roadmap: "frontend", slug: "javascript" } },
  { id: "n-concept" },
  { id: "n-closures", catalogTopic: { roadmap: "frontend", slug: "closures" } },
  { id: "n-backend-js", catalogTopic: { roadmap: "backend", slug: "javascript" } },
];

test("with catalog edges, a linked node depends on the linked nodes of its catalog prerequisites", () => {
  const byId = new Map(nodePrerequisites(pathNodes, edgeCatalog).map((entry) => [entry.nodeId, entry]));
  assert.deepEqual(byId.get("n-js"), { nodeId: "n-js", prerequisiteIds: ["n-html", "n-css"], source: "catalog" });
  assert.deepEqual(byId.get("n-closures"), { nodeId: "n-closures", prerequisiteIds: ["n-js"], source: "catalog" });
});

test("without catalog edges, or for unlinked nodes, the prerequisite is the module-order predecessor", () => {
  const byId = new Map(nodePrerequisites(pathNodes, edgeCatalog).map((entry) => [entry.nodeId, entry]));
  // The first node has no predecessor.
  assert.deepEqual(byId.get("n-html"), { nodeId: "n-html", prerequisiteIds: [], source: "module-order" });
  // An unlinked node falls back to the node before it.
  assert.deepEqual(byId.get("n-concept"), {
    nodeId: "n-concept",
    prerequisiteIds: ["n-js"],
    source: "module-order",
  });
  // A linked topic with no edges to linked nodes falls back as well.
  assert.deepEqual(byId.get("n-backend-js"), {
    nodeId: "n-backend-js",
    prerequisiteIds: ["n-closures"],
    source: "module-order",
  });
});

test("a catalog without edges yields module order for every node", () => {
  const edgeless: EdgeCatalogView = {
    roadmaps: edgeCatalog.roadmaps.map((roadmap) => ({
      slug: roadmap.slug,
      topics: roadmap.topics.map((topic) => ({ slug: topic.slug, prerequisites: [] })),
    })),
  };
  const result = nodePrerequisites(pathNodes, edgeless);
  assert.ok(result.every((entry) => entry.source === "module-order"));
  assert.deepEqual(
    result.map((entry) => entry.prerequisiteIds),
    [[], ["n-html"], ["n-css"], ["n-js"], ["n-concept"], ["n-closures"]],
  );
});

test("a link to a topic missing from the catalog falls back to module order", () => {
  const nodes: LinkedNode[] = [
    { id: "n-a" },
    { id: "n-b", catalogTopic: { roadmap: "frontend", slug: "retired-topic" } },
  ];
  assert.deepEqual(nodePrerequisites(nodes, edgeCatalog)[1], {
    nodeId: "n-b",
    prerequisiteIds: ["n-a"],
    source: "module-order",
  });
});
