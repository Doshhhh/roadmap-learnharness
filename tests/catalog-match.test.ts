import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mastery } from "../src/learner-map.ts";
import {
  candidateKey,
  matchCatalog,
  rankRoadmaps,
  type CatalogView,
  type RerankPick,
  type RoadmapMatch,
} from "../src/catalog-match.ts";

const catalog: CatalogView = {
  roadmaps: [
    {
      slug: "frontend",
      title: "Frontend",
      topics: [
        { slug: "html", title: "HTML" },
        { slug: "css", title: "CSS" },
        { slug: "javascript", title: "JavaScript" },
        { slug: "react", title: "React" },
      ],
    },
    {
      slug: "backend",
      title: "Backend",
      topics: [
        { slug: "javascript", title: "JavaScript" },
        { slug: "sql", title: "SQL" },
        { slug: "http", title: "HTTP" },
      ],
    },
    {
      slug: "devops",
      title: "DevOps",
      topics: [
        { slug: "linux", title: "Linux" },
        { slug: "docker", title: "Docker" },
      ],
    },
    {
      slug: "qa",
      title: "QA",
      topics: [{ slug: "testing", title: "Testing" }],
    },
  ],
};

function mastery(...topicIds: string[]): Mastery[] {
  return topicIds.map(topicId => ({
    topicId,
    level: "seen" as const,
    evidence: [{ sessionId: "s1", at: "2026-01-02T00:00:00Z" }],
  }));
}

/** A rerank stub that records how often it was called and the candidates it saw. */
function spyRerank(answer: (candidates: RoadmapMatch[]) => Promise<RerankPick | null>) {
  const calls: RoadmapMatch[][] = [];
  const rerank = async (candidates: RoadmapMatch[]) => {
    calls.push(candidates);
    return answer(candidates);
  };
  return { rerank, calls };
}

test("rankRoadmaps orders by overlap, best first", () => {
  // frontend: html, css, javascript (3/4 = 0.75); backend: javascript, sql (2/3 ≈ 0.67); devops: linux (1/2 = 0.5)
  const ranked = rankRoadmaps(mastery("html", "css", "javascript", "sql", "linux"), catalog);
  assert.deepEqual(
    ranked.map(match => [match.roadmap, match.seen, match.total]),
    [
      ["frontend", 3, 4],
      ["backend", 2, 3],
      ["devops", 1, 2],
    ],
  );
  assert.deepEqual(ranked[0]?.matchedTopics, ["css", "html", "javascript"]);
});

test("deterministic ranking: equal overlap breaks on roadmap slug", () => {
  // alpha and beta both have 1/2 overlap with one seen topic each, so slug decides.
  const tieCatalog: CatalogView = {
    roadmaps: [
      { slug: "beta", title: "Beta", topics: [{ slug: "x", title: "X" }, { slug: "y", title: "Y" }] },
      { slug: "alpha", title: "Alpha", topics: [{ slug: "x", title: "X" }, { slug: "z", title: "Z" }] },
      { slug: "gamma", title: "Gamma", topics: [{ slug: "x", title: "X" }, { slug: "y", title: "Y" }, { slug: "z", title: "Z" }, { slug: "w", title: "W" }] },
    ],
  };
  const ranked = rankRoadmaps(mastery("x"), tieCatalog);
  assert.deepEqual(ranked.map(match => match.roadmap), ["alpha", "beta", "gamma"]);
  assert.equal(ranked[0]?.overlap, 0.5);
  assert.equal(ranked[2]?.overlap, 0.25);
});

test("matchCatalog without a model pass uses the deterministic top candidate", async () => {
  const result = await matchCatalog({ mastery: mastery("html", "css", "javascript"), catalog });
  assert.equal(result.selected?.roadmap, "frontend");
  assert.equal(result.source, "deterministic");
  assert.equal(result.modelOutcome, "not-called");
  assert.equal(result.reason, "highest topic overlap (3/4)");
  assert.deepEqual(result.matchedTopics, ["css", "html", "javascript"]);
  assert.deepEqual(result.frontier, [{ slug: "react", title: "React" }]);
  assert.deepEqual(result.candidates.map(match => match.roadmap), ["frontend", "backend"]);
});

test("empty learner data selects nothing and never calls the model", async () => {
  const { rerank, calls } = spyRerank(async () => ({ roadmap: "frontend", reason: "unused" }));
  const result = await matchCatalog({ mastery: [], catalog, rerank });
  assert.equal(result.selected, null);
  assert.equal(result.source, "none");
  assert.equal(result.reason, "no learner topics match any roadmap");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.matchedTopics, []);
  assert.deepEqual(result.frontier, []);
  assert.equal(result.modelOutcome, "not-called");
  assert.equal(calls.length, 0);
});

test("a frontier with no matches is empty and never calls the model", async () => {
  // Learner topics exist but none is a catalog topic slug.
  const { rerank, calls } = spyRerank(async () => ({ roadmap: "frontend", reason: "unused" }));
  const result = await matchCatalog({ mastery: mastery("rust", "cooking"), catalog, rerank });
  assert.equal(result.selected, null);
  assert.equal(result.source, "none");
  assert.deepEqual(result.frontier, []);
  assert.deepEqual(result.matchedTopics, []);
  assert.equal(calls.length, 0);
});

test("the model is given only the top N candidates", async () => {
  const { rerank, calls } = spyRerank(async () => null);
  // qa 1/1, devops 1/2, backend 1/3, frontend 1/4: the top two are qa and devops.
  await matchCatalog({ mastery: mastery("javascript", "linux", "testing"), catalog, rerank, topN: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.map(match => match.roadmap), ["qa", "devops"]);
});

test("an invalid model answer falls back to the deterministic top result", async () => {
  const cache = new Map<string, RerankPick>();
  const { rerank } = spyRerank(async () => ({ roadmap: "not-a-candidate", reason: "made up" }));
  const result = await matchCatalog({ mastery: mastery("html", "css", "javascript"), catalog, rerank, cache });
  assert.equal(result.selected?.roadmap, "frontend");
  assert.equal(result.source, "deterministic");
  assert.equal(result.modelOutcome, "invalid");
  assert.match(result.reason, /ignored/);
  assert.equal(cache.size, 0, "an invalid answer is not cached");
});

test("an empty or missing reason is an invalid answer", async () => {
  // backend 2/3 is the deterministic top here, so the blank answer must fall back to it.
  const { rerank } = spyRerank(async () => ({ roadmap: "frontend", reason: "   " }));
  const result = await matchCatalog({ mastery: mastery("html", "javascript", "sql"), catalog, rerank });
  assert.equal(result.selected?.roadmap, "backend");
  assert.equal(result.source, "deterministic");
  assert.equal(result.modelOutcome, "invalid");
});

test("a thrown model call falls back, reports failure, and is not cached", async () => {
  const cache = new Map<string, RerankPick>();
  let attempts = 0;
  const { rerank } = spyRerank(async () => {
    attempts += 1;
    throw new Error("network down");
  });
  const first = await matchCatalog({ mastery: mastery("html", "css", "javascript"), catalog, rerank, cache });
  assert.equal(first.selected?.roadmap, "frontend");
  assert.equal(first.source, "deterministic");
  assert.equal(first.modelOutcome, "failed");
  assert.match(first.reason, /model call failed/);
  assert.equal(cache.size, 0, "a failed call is not cached");

  // The next call retries the model rather than reusing a failure.
  await matchCatalog({ mastery: mastery("html", "css", "javascript"), catalog, rerank, cache });
  assert.equal(attempts, 2);
});

test("a null model answer counts as a failed call", async () => {
  const { rerank } = spyRerank(async () => null);
  const result = await matchCatalog({ mastery: mastery("html"), catalog, rerank });
  assert.equal(result.modelOutcome, "failed");
  assert.equal(result.source, "deterministic");
});

test("a valid model answer is used, with its reason, and is cached by candidate set", async () => {
  const cache = new Map<string, RerankPick>();
  // backend (3/3) is the deterministic top; the model picks frontend (2/4) instead.
  const { rerank, calls } = spyRerank(async () => ({ roadmap: "frontend", reason: "  closest to your HTML and JS notes  " }));
  const learner = mastery("javascript", "sql", "http", "html");
  const result = await matchCatalog({ mastery: learner, catalog, rerank, cache });
  assert.equal(result.selected?.roadmap, "frontend");
  assert.equal(result.source, "model");
  assert.equal(result.modelOutcome, "accepted");
  assert.equal(result.reason, "closest to your HTML and JS notes");
  assert.deepEqual(result.matchedTopics, ["html", "javascript"]);
  assert.deepEqual(result.frontier, [
    { slug: "css", title: "CSS" },
    { slug: "react", title: "React" },
  ]);
  assert.equal(cache.get(candidateKey(result.candidates))?.roadmap, "frontend");

  const second = await matchCatalog({ mastery: learner, catalog, rerank, cache });
  assert.equal(second.modelOutcome, "cached");
  assert.equal(second.selected?.roadmap, "frontend");
  assert.equal(calls.length, 1, "the same candidate set is answered from the cache");
});

test("candidateKey is stable across candidate order", () => {
  const a = { roadmap: "backend" } as RoadmapMatch;
  const b = { roadmap: "frontend" } as RoadmapMatch;
  assert.equal(candidateKey([a, b]), candidateKey([b, a]));
});
