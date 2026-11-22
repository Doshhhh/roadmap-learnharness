import snapshot from "./catalog-snapshot.json" with { type: "json" };

export type CatalogTopic = {
  slug: string;
  title: string;
  roadmap: string;
  prerequisites: string[];
  prerequisiteSource: "curated" | "inferred" | "none";
};

export type CatalogRoadmap = {
  slug: string;
  title: string;
  url: string;
  topics: CatalogTopic[];
};

export type Catalog = {
  snapshotVersion: number;
  roadmaps: CatalogRoadmap[];
};

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_TITLE_LENGTH = 120;
const PREREQUISITE_SOURCES = new Set(["curated", "inferred", "none"]);
const ROADMAP_URL_PREFIX = "https://roadmap.sh/";
// Exact key sets. The snapshot's source metadata is allowed at the root only.
const ROOT_KEYS = ["snapshotVersion", "sourceRepo", "sourceCommit", "roadmaps"] as const;
const ROADMAP_KEYS = ["slug", "title", "url", "topics"] as const;
const TOPIC_KEYS = ["slug", "title", "roadmap", "prerequisites", "prerequisiteSource"] as const;

function fail(path: string, problem: string): never {
  throw new Error(`Invalid catalog at ${path}: ${problem}`);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

// Rejects any key outside the agreed shape, so upstream text (descriptions, bodies, links) cannot
// slip into the catalog through an extra field.
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, `unexpected key ${JSON.stringify(key)}`);
  }
}

function expectSlug(value: unknown, path: string): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    fail(path, `expected a lowercase-hyphen slug, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectTitle(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string title");
  if (value.trim() !== value || value.length === 0) fail(path, "title must be non-empty and trimmed");
  if (value.length > MAX_TITLE_LENGTH) fail(path, `title is longer than ${MAX_TITLE_LENGTH} characters`);
  if (/[\r\n]/.test(value)) fail(path, "title must be a single line");
  if (value.includes("](") || /https?:\/\//.test(value)) fail(path, "title looks like a markdown link or URL");
  return value;
}

function validateTopic(value: unknown, roadmap: string, path: string): CatalogTopic {
  const topic = expectRecord(value, path);
  rejectUnknownKeys(topic, TOPIC_KEYS, path);
  const slug = expectSlug(topic.slug, `${path}.slug`);
  const title = expectTitle(topic.title, `${path}.title`);
  if (topic.roadmap !== roadmap) fail(`${path}.roadmap`, `must equal the parent roadmap slug ${JSON.stringify(roadmap)}`);
  if (!Array.isArray(topic.prerequisites)) fail(`${path}.prerequisites`, "expected an array");
  const prerequisites = topic.prerequisites.map((item, index) =>
    expectSlug(item, `${path}.prerequisites[${index}]`),
  );
  if (typeof topic.prerequisiteSource !== "string" || !PREREQUISITE_SOURCES.has(topic.prerequisiteSource)) {
    fail(`${path}.prerequisiteSource`, "must be \"curated\", \"inferred\" or \"none\"");
  }
  if (topic.prerequisiteSource === "none" && prerequisites.length > 0) {
    fail(`${path}.prerequisites`, "must be empty when prerequisiteSource is \"none\"");
  }
  return {
    slug,
    title,
    roadmap,
    prerequisites,
    prerequisiteSource: topic.prerequisiteSource as CatalogTopic["prerequisiteSource"],
  };
}

function validateRoadmap(value: unknown, path: string): CatalogRoadmap {
  const roadmap = expectRecord(value, path);
  rejectUnknownKeys(roadmap, ROADMAP_KEYS, path);
  const slug = expectSlug(roadmap.slug, `${path}.slug`);
  const title = expectTitle(roadmap.title, `${path}.title`);
  if (roadmap.url !== `${ROADMAP_URL_PREFIX}${slug}`) {
    fail(`${path}.url`, `must be ${ROADMAP_URL_PREFIX}${slug}`);
  }
  if (!Array.isArray(roadmap.topics)) fail(`${path}.topics`, "expected an array");
  const seen = new Set<string>();
  const topics = roadmap.topics.map((item, index) => {
    const topic = validateTopic(item, slug, `${path}.topics[${index}]`);
    if (seen.has(topic.slug)) fail(`${path}.topics[${index}].slug`, `duplicate topic slug ${JSON.stringify(topic.slug)}`);
    seen.add(topic.slug);
    return topic;
  });
  return { slug, title, url: roadmap.url, topics };
}

// Checks a catalog value and returns a fresh copy holding only the Catalog fields.
// Source metadata in the snapshot (sourceRepo, sourceCommit) is not part of the returned value.
export function validateCatalog(value: unknown): Catalog {
  const root = expectRecord(value, "catalog");
  rejectUnknownKeys(root, ROOT_KEYS, "catalog");
  const { snapshotVersion } = root;
  if (typeof snapshotVersion !== "number" || !Number.isInteger(snapshotVersion) || snapshotVersion < 1) {
    fail("catalog.snapshotVersion", "expected a positive integer");
  }
  if (!Array.isArray(root.roadmaps)) fail("catalog.roadmaps", "expected an array");
  const seen = new Set<string>();
  const roadmaps = root.roadmaps.map((item, index) => {
    const roadmap = validateRoadmap(item, `catalog.roadmaps[${index}]`);
    if (seen.has(roadmap.slug)) fail(`catalog.roadmaps[${index}].slug`, `duplicate roadmap slug ${JSON.stringify(roadmap.slug)}`);
    seen.add(roadmap.slug);
    return roadmap;
  });
  return { snapshotVersion, roadmaps };
}

// The snapshot is a static import; validation runs on every call so each caller gets its own copy.
export function loadCatalog(): Catalog {
  return validateCatalog(snapshot);
}
