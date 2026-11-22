import assert from "node:assert/strict";
import { test } from "node:test";
import {
  frontierPivots,
  seedFromCatalogRoadmap,
  type FrontierTopic,
  type LinkableNode,
  type SeedRoadmap,
} from "../src/catalog-seed.ts";

const roadmap: SeedRoadmap = {
  slug: "backend",
  title: "Backend",
  topics: [
    { slug: "http", title: "HTTP" },
    { slug: "sql", title: "SQL" },
    { slug: "caching", title: "Caching" },
    { slug: "queues", title: "Message queues" },
  ],
};

test("seeding keeps catalog order and returns plain data", () => {
  const seed = seedFromCatalogRoadmap(roadmap);
  assert.equal(seed.roadmap, "backend");
  assert.equal(seed.title, "Backend");
  const topics = seed.groups.flatMap(group => group.topics.map(topic => topic.slug));
  assert.deepEqual(topics, ["http", "sql", "caching", "queues"]);
  assert.deepEqual(seed.groups[0]?.topics[1], { slug: "sql", title: "SQL" });
});

test("seeding does not mutate the catalog roadmap", () => {
  const before = JSON.stringify(roadmap);
  seedFromCatalogRoadmap(roadmap);
  assert.equal(JSON.stringify(roadmap), before);
});

test("frontier topics already linked by an existing node are excluded", () => {
  const frontier: FrontierTopic[] = [
    { roadmap: "backend", slug: "http", title: "HTTP" },
    { roadmap: "backend", slug: "sql", title: "SQL" },
  ];
  const nodes: LinkableNode[] = [
    { id: "n1", catalogTopic: { roadmap: "backend", slug: "http" } },
    { id: "n2" },
  ];
  const pivots = frontierPivots(frontier, nodes, "2026-11-22T10:00:00.000Z");
  assert.deepEqual(pivots.map(pivot => pivot.title), ["SQL"]);
});

test("a link to the same slug in another roadmap does not count as covering", () => {
  const frontier: FrontierTopic[] = [{ roadmap: "frontend", slug: "http", title: "HTTP" }];
  const nodes: LinkableNode[] = [{ id: "n1", catalogTopic: { roadmap: "backend", slug: "http" } }];
  assert.equal(frontierPivots(frontier, nodes, "2026-11-22T10:00:00.000Z").length, 1);
});

test("a frontier topic with no link produces one pending proposal in PivotSuggestion shape", () => {
  const createdAt = "2026-11-22T10:00:00.000Z";
  const pivots = frontierPivots([{ roadmap: "backend", slug: "caching", title: "Caching" }], [], createdAt);
  assert.equal(pivots.length, 1);
  const [pivot] = pivots;
  assert.ok(pivot);
  assert.equal(pivot.status, "pending");
  assert.equal(pivot.proposalType, "bridge");
  assert.equal(pivot.title, "Caching");
  assert.equal(pivot.createdAt, createdAt);
  assert.equal(pivot.resolvedAt, undefined);
  assert.equal(pivot.insertedNodeId, undefined);
  assert.match(pivot.rationale, /"Caching"/);
  assert.equal(pivot.id, "pivot-catalog-backend-caching");
});

test("proposal ids are stable across calls", () => {
  const frontier: FrontierTopic[] = [{ roadmap: "backend", slug: "queues", title: "Message queues" }];
  const first = frontierPivots(frontier, [], "2026-11-22T10:00:00.000Z");
  const second = frontierPivots(frontier, [], "2026-11-23T10:00:00.000Z");
  assert.equal(first[0]?.id, second[0]?.id);
});

test("nothing is inserted into any roadmap or node", () => {
  const nodes: LinkableNode[] = [{ id: "n1", catalogTopic: { roadmap: "backend", slug: "http" } }];
  const frontier: FrontierTopic[] = [
    { roadmap: "backend", slug: "sql", title: "SQL" },
    { roadmap: "backend", slug: "queues", title: "Message queues" },
  ];
  const nodesBefore = JSON.stringify(nodes);
  const frontierBefore = JSON.stringify(frontier);
  const roadmapBefore = JSON.stringify(roadmap);

  const pivots = frontierPivots(frontier, nodes, "2026-11-22T10:00:00.000Z");
  seedFromCatalogRoadmap(roadmap);

  assert.equal(pivots.length, 2);
  for (const pivot of pivots) {
    assert.equal(pivot.status, "pending");
    assert.equal(pivot.insertedNodeId, undefined);
  }
  assert.equal(JSON.stringify(nodes), nodesBefore);
  assert.equal(JSON.stringify(frontier), frontierBefore);
  assert.equal(JSON.stringify(roadmap), roadmapBefore);
});
