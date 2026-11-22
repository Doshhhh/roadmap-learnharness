import assert from "node:assert/strict";
import { test } from "node:test";
import snapshot from "../src/catalog-snapshot.json" with { type: "json" };
import { loadCatalog, validateCatalog, type Catalog } from "../src/catalog.ts";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validCatalog(): Catalog {
  return {
    snapshotVersion: 1,
    roadmaps: [
      {
        slug: "frontend",
        title: "Frontend",
        url: "https://roadmap.sh/frontend",
        topics: [
          {
            slug: "closures",
            title: "Closures",
            roadmap: "frontend",
            prerequisites: [],
            prerequisiteSource: "none",
          },
        ],
      },
    ],
  };
}

test("the committed snapshot validates", () => {
  const catalog = loadCatalog();
  assert.equal(catalog.snapshotVersion, snapshot.snapshotVersion);
  assert.ok(catalog.roadmaps.length > 0, "snapshot has roadmaps");
  assert.ok(catalog.roadmaps.every((roadmap) => roadmap.topics.length > 0), "every roadmap has topics");
});

test("the snapshot records its upstream source", () => {
  assert.equal(snapshot.sourceRepo, "nilbuild/developer-roadmap");
  assert.match(snapshot.sourceCommit, /^[0-9a-f]{40}$/);
});

test("loadCatalog returns only the Catalog fields and a fresh copy each call", () => {
  const first = loadCatalog();
  assert.deepEqual(Object.keys(first).sort(), ["roadmaps", "snapshotVersion"]);
  first.roadmaps[0]!.topics.length = 0;
  assert.ok(loadCatalog().roadmaps[0]!.topics.length > 0, "mutating one result does not affect the next");
});

test("validateCatalog accepts a well-formed value", () => {
  assert.deepEqual(validateCatalog(validCatalog()), validCatalog());
});

test("validateCatalog rejects unknown keys instead of dropping them", () => {
  const topicWithDescription = withTopic((t) => ({ ...t, description: "upstream text" }));
  assert.throws(() => validateCatalog(topicWithDescription), /topics\[0\]\.description.*unexpected key "description"/);

  const roadmapWithBody = withRoadmap((r) => ({ ...r, body: "upstream text" }));
  assert.throws(() => validateCatalog(roadmapWithBody), /roadmaps\[0\]\.body.*unexpected key "body"/);

  const rootWithExtra = { ...validCatalog(), links: [] };
  assert.throws(() => validateCatalog(rootWithExtra), /catalog\.links.*unexpected key "links"/);
});

test("validateCatalog rejects wrong shapes with a clear message", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["null", null, /expected an object/],
    ["array", [], /expected an object/],
    ["missing roadmaps", { snapshotVersion: 1 }, /catalog\.roadmaps: expected an array/],
    ["zero version", { snapshotVersion: 0, roadmaps: [] }, /snapshotVersion/],
    ["string version", { snapshotVersion: "1", roadmaps: [] }, /snapshotVersion/],
    ["roadmap without url", { snapshotVersion: 1, roadmaps: [{ ...validCatalog().roadmaps[0], url: undefined }] }, /url/],
    ["foreign roadmap url", withRoadmap((r) => ({ ...r, url: "https://example.com/frontend" })), /url/],
    ["uppercase roadmap slug", withRoadmap((r) => ({ ...r, slug: "Frontend", url: "https://roadmap.sh/Frontend" })), /slug/],
    ["double-hyphen topic slug", withTopic((t) => ({ ...t, slug: "ci--cd" })), /slug/],
    ["topic roadmap mismatch", withTopic((t) => ({ ...t, roadmap: "backend" })), /parent roadmap/],
    ["prerequisites without source", withTopic((t) => ({ ...t, prerequisites: ["closures"] })), /must be empty/],
    ["unknown prerequisite source", withTopic((t) => ({ ...t, prerequisiteSource: "guessed" })), /prerequisiteSource/],
    ["prerequisite not a slug", withTopic((t) => ({ ...t, prerequisiteSource: "curated", prerequisites: ["Bad Slug"] })), /prerequisites\[0\]/],
    ["empty title", withTopic((t) => ({ ...t, title: "" })), /title/],
    ["title with newline", withTopic((t) => ({ ...t, title: "Closures\nbody text" })), /single line/],
    ["title over 120 characters", withTopic((t) => ({ ...t, title: "x".repeat(121) })), /longer than 120/],
    ["title as markdown link", withTopic((t) => ({ ...t, title: "[Closures](https://example.com)" })), /markdown link/],
    ["duplicate roadmap", { snapshotVersion: 1, roadmaps: [validCatalog().roadmaps[0], validCatalog().roadmaps[0]] }, /duplicate roadmap/],
    ["duplicate topic", withDuplicateTopic(), /duplicate topic slug/],
  ];
  for (const [name, value, message] of cases) {
    assert.throws(() => validateCatalog(value), message, name);
  }
});

test("every roadmap and topic slug in the snapshot is lowercase-hyphen", () => {
  for (const roadmap of loadCatalog().roadmaps) {
    assert.match(roadmap.slug, SLUG, `roadmap slug ${roadmap.slug}`);
    for (const topic of roadmap.topics) {
      assert.match(topic.slug, SLUG, `topic slug ${topic.slug} in ${roadmap.slug}`);
      assert.equal(topic.roadmap, roadmap.slug);
    }
  }
});

test("no topic title or roadmap url contains a newline or looks like a markdown link", () => {
  for (const roadmap of loadCatalog().roadmaps) {
    assert.ok(!/[\r\n]/.test(roadmap.url), `url of ${roadmap.slug}`);
    assert.equal(roadmap.url, `https://roadmap.sh/${roadmap.slug}`);
    assert.ok(!roadmap.title.includes("](") && !roadmap.title.includes("http"), `title of ${roadmap.slug}`);
    for (const topic of roadmap.topics) {
      assert.ok(!/[\r\n]/.test(topic.title), `title of ${topic.slug}`);
      assert.ok(topic.title.length <= 120, `title length of ${topic.slug}`);
      assert.ok(!topic.title.includes("](") && !/https?:\/\//.test(topic.title), `title of ${topic.slug}`);
    }
  }
});

test("snapshot topics carry no prerequisites yet", () => {
  for (const roadmap of loadCatalog().roadmaps) {
    for (const topic of roadmap.topics) {
      assert.deepEqual(topic.prerequisites, []);
      assert.equal(topic.prerequisiteSource, "none");
    }
  }
});

function withRoadmap(change: (roadmap: Catalog["roadmaps"][number]) => unknown): unknown {
  const catalog = validCatalog();
  return { snapshotVersion: 1, roadmaps: [change(catalog.roadmaps[0]!)] };
}

function withTopic(change: (topic: Catalog["roadmaps"][number]["topics"][number]) => unknown): unknown {
  const catalog = validCatalog();
  const topic = change(catalog.roadmaps[0]!.topics[0]!);
  return { snapshotVersion: 1, roadmaps: [{ ...catalog.roadmaps[0], topics: [topic] }] };
}

function withDuplicateTopic(): unknown {
  const catalog = validCatalog();
  const topic = catalog.roadmaps[0]!.topics[0]!;
  return { snapshotVersion: 1, roadmaps: [{ ...catalog.roadmaps[0], topics: [topic, topic] }] };
}
