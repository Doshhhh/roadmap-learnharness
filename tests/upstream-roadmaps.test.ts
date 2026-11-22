/** Upstream roadmap source and the Architect's upstream mode (issue #19).
 *
 * Synthetic data only. Every GitHub request goes through a fake fetch that replays
 * recorded synthetic responses; nothing touches the network. No model is called.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginAgentTool, PluginBackendContext } from "learnharness-plugin-api";
import { buildArchitectDefinition, recalledRoadmapPath } from "../src/architect-agent.ts";
import { buildArchitectSystemPrompt } from "../src/framework.ts";
import type { ArchitectModelConfig } from "../src/store.ts";
import { openLearningPathStore } from "../src/store.ts";
import {
  UPSTREAM_API_BASE,
  UPSTREAM_PINNED_COMMIT,
  UPSTREAM_REPOSITORY,
  UpstreamError,
  assertSlug,
  listRoadmapTopics,
  parseTopicMarkdown,
  readTopic,
  withUpstreamTimeout,
} from "../src/upstream-roadmaps.ts";
import type { UpstreamFetch } from "../src/upstream-roadmaps.ts";
import { rawPath } from "./fixtures.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ROOT = `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps`;

/** Recorded synthetic responses, keyed by the exact request URL. */
const LISTING = JSON.stringify([
  { name: "synthetic-topic@aB3_x.md", type: "file" },
  { name: "other-topic@Qz9-k.md", type: "file" },
  { name: "README.md", type: "file" },
  { name: "not-a-topic.txt", type: "file" },
]);
const TOPIC_MD = [
  "# Synthetic Topic",
  "",
  "A short synthetic description of the topic.",
  "",
  "Visit the following resources to learn more:",
  "",
  "- [@official@Example Docs](https://docs.example.test/start?lang=en&v=2)",
  "- [@book@Example Book](https://books.example.test/b/1)",
  "- [Plain link without a tag](https://plain.example.test/x)",
  "- [@book@Example Book](https://books.example.test/b/1)",
  "- [@article@Second Article](https://articles.example.test/a)",
  "",
].join("\n");

interface ToolResult {
  content: { type: string; text: string }[];
  details: unknown;
  isError?: boolean;
}

interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A fake fetch that replays `routes` and records every call. A null route throws (unreachable). */
function fakeFetch(routes: Record<string, { status: number; body: string } | null>): { fetch: UpstreamFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: UpstreamFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const route = routes[url];
    if (route === null) throw new TypeError("synthetic network failure");
    if (route === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => route.body };
  };
  return { fetch, calls };
}

const standardRoutes = () => ({
  [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: { status: 200, body: LISTING },
  [`${ROOT}/synthetic-roadmap/content/synthetic-topic@aB3_x.md?ref=${COMMIT}`]: { status: 200, body: TOPIC_MD },
});

const isUpstreamError = (kind: string) => (error: unknown) => error instanceof UpstreamError && error.kind === kind;

test("listRoadmapTopics returns the topic slugs and files, and ignores other names", async () => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  const topics = await listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch });
  assert.deepEqual(topics, [
    { slug: "synthetic-topic", file: "synthetic-topic@aB3_x.md" },
    { slug: "other-topic", file: "other-topic@Qz9-k.md" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`);
});

test("readTopic returns title, description and resources exactly as the file writes them", async () => {
  const { fetch } = fakeFetch(standardRoutes());
  const topic = await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  assert.equal(topic.title, "Synthetic Topic");
  assert.equal(topic.description, "A short synthetic description of the topic.");
  assert.equal(topic.source, "roadmap.sh");
  assert.equal(topic.commit, COMMIT);
  // Tag kept in the label, URL verbatim (query string included), untagged links skipped, duplicates dropped.
  assert.deepEqual(topic.resources, [
    { label: "@official@Example Docs", tag: "official", url: "https://docs.example.test/start?lang=en&v=2" },
    { label: "@book@Example Book", tag: "book", url: "https://books.example.test/b/1" },
    { label: "@article@Second Article", tag: "article", url: "https://articles.example.test/a" },
  ]);
});

test("parseTopicMarkdown copes with a file that has no title or description", () => {
  const parsed = parseTopicMarkdown("- [@book@Only Book](https://books.example.test/only)\n");
  assert.equal(parsed.title, "");
  assert.equal(parsed.description, "");
  assert.deepEqual(parsed.resources, [{ label: "@book@Only Book", tag: "book", url: "https://books.example.test/only" }]);
});

test("slugs that are not plain slugs are rejected before any request", async () => {
  const bad = ["", "../etc", "a/b", "A-Upper", "has space", "x@y", "a---b", "-lead", "trail-", "--x", "x--", "%2e%2e", "a".repeat(81), "frontend?x=1"];
  for (const slug of bad) {
    const { fetch, calls } = fakeFetch(standardRoutes());
    await assert.rejects(listRoadmapTopics(slug, COMMIT, { fetch }), isUpstreamError("invalid"), `roadmap ${slug}`);
    await assert.rejects(readTopic("synthetic-roadmap", slug, COMMIT, { fetch }), isUpstreamError("invalid"), `topic ${slug}`);
    await assert.rejects(readTopic(slug, "synthetic-topic", COMMIT, { fetch }), isUpstreamError("invalid"), `roadmap ${slug}`);
    assert.equal(calls.length, 0, `no request for ${JSON.stringify(slug)}`);
  }
});

test("a commit that is not a full SHA is rejected before any request", async () => {
  for (const commit of ["main", "0123456", COMMIT.toUpperCase(), `${COMMIT}&x=1`, "../../abc"]) {
    const { fetch, calls } = fakeFetch(standardRoutes());
    await assert.rejects(readTopic("synthetic-roadmap", "synthetic-topic", commit, { fetch }), isUpstreamError("invalid"));
    assert.equal(calls.length, 0);
  }
});

test("every request stays under roadmaps/ at the pinned commit", async () => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.startsWith(`${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps/`), call.url);
    assert.ok(call.url.endsWith(`ref=${COMMIT}`), call.url);
  }
});

test("an unreachable GitHub is reported as an error, and no other source is asked", async () => {
  const { fetch, calls } = fakeFetch({ [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: null });
  await assert.rejects(listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch }), isUpstreamError("unreachable"));
  assert.equal(calls.length, 1);
  assert.ok(calls.every((call) => call.url.startsWith(`${UPSTREAM_API_BASE}/`)), "only the GitHub API is asked");
});

test("a 500 is unreachable, an unknown roadmap is not found, and a missing topic is not found", async () => {
  const server = fakeFetch({ [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: { status: 500, body: "" } });
  await assert.rejects(listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch: server.fetch }), isUpstreamError("unreachable"));

  const missing = fakeFetch({});
  await assert.rejects(listRoadmapTopics("no-such-roadmap", COMMIT, { fetch: missing.fetch }), isUpstreamError("not_found"));

  const { fetch } = fakeFetch(standardRoutes());
  await assert.rejects(readTopic("synthetic-roadmap", "absent-topic", COMMIT, { fetch }), isUpstreamError("not_found"));
});

test("a GitHub request that never answers is abandoned at the timeout and reported as unreachable", async () => {
  let aborted = false;
  const hanging = (_url: string, init: { headers: Readonly<Record<string, string>>; signal: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  const fetch = withUpstreamTimeout(hanging, 20);
  await assert.rejects(listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch }), isUpstreamError("unreachable"));
  assert.equal(aborted, true, "the request was aborted by the timeout");
});

test("a fast GitHub response passes through the timeout wrapper unchanged", async () => {
  const { fetch: inner, calls } = fakeFetch(standardRoutes());
  const fetch = withUpstreamTimeout(async (url, init) => inner(url, init), 5_000);
  const topic = await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  assert.equal(topic.title, "Synthetic Topic");
  assert.equal(calls.length, 2);
});

test("with a listings cache, the roadmap listing is read once for several topic reads", async () => {
  const { fetch, calls } = fakeFetch({
    ...standardRoutes(),
    [`${ROOT}/synthetic-roadmap/content/other-topic@Qz9-k.md?ref=${COMMIT}`]: { status: 200, body: TOPIC_MD },
  });
  const listings = new Map();
  const options = { fetch, listings };
  const first = await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, options);
  const second = await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, options);
  const other = await readTopic("synthetic-roadmap", "other-topic", COMMIT, options);
  assert.deepEqual(second, first);
  assert.equal(other.slug, "other-topic");
  assert.deepEqual((await listRoadmapTopics("synthetic-roadmap", COMMIT, options)).map((topic) => topic.slug), ["synthetic-topic", "other-topic"]);
  const listingCalls = calls.filter((call) => call.url.includes("/content?ref="));
  assert.equal(listingCalls.length, 1, "the listing is read once");
  assert.equal(calls.length, 4, "one listing and one request per topic file");
});

test("without a listings cache every topic read lists the roadmap again, as before", async () => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  await readTopic("synthetic-roadmap", "synthetic-topic", COMMIT, { fetch });
  assert.equal(calls.length, 4);
});

test("a failed listing is not kept: the next call asks GitHub again", async () => {
  const route = `${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`;
  const routes: Record<string, { status: number; body: string } | null> = { [route]: null };
  const { fetch, calls } = fakeFetch(routes);
  const listings = new Map();
  await assert.rejects(listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch, listings }), isUpstreamError("unreachable"));
  assert.equal(listings.size, 0, "the failed listing is removed from the cache");
  routes[route] = { status: 200, body: LISTING };
  const topics = await listRoadmapTopics("synthetic-roadmap", COMMIT, { fetch, listings });
  assert.equal(topics.length, 2);
  assert.equal(calls.length, 2);
});

/** A save whose only source is `sourceId`; resources are removed so the upstream link guard does not apply. */
function uploadedDraft(sourceId: string, id = `path-${sourceId.slice(0, 8).toLowerCase()}`) {
  const draft = rawPath();
  draft.id = id;
  draft.sourceSpine = {
    mode: "uploaded",
    references: [{ title: "Synthetic corpus", kind: "textbook" }],
    sources: [{ sourceId, name: "corpus.md", uploadedAt: "2026-01-31T09:30:00.000Z" }],
  } as typeof draft.sourceSpine;
  for (const module of draft.modules) for (const node of module.nodes) delete node.resources;
  return draft;
}

const SOURCE_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CAPITAL_UUID = "AB12CD34-EF56-4789-9ABC-DEF012345678";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("a normal readable uploaded source is accepted, and its text is not loaded to check it", async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  store.writeSource(SOURCE_UUID, "# Stored source\n\nSynthetic text.");
  const reads: string[] = [];
  const readSource = store.readSource;
  store.readSource = (sourceId: string) => {
    reads.push(sourceId);
    return readSource(sourceId);
  };
  const saved = await tool("save_learning_path").execute("c1", uploadedDraft(SOURCE_UUID), undefined);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  assert.deepEqual(reads, [], "the stored source is confirmed from its metadata");
});

test("a missing uploaded source is refused and no path is written", async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  const saved = await tool("save_learning_path").execute("c1", uploadedDraft(SOURCE_UUID), undefined);
  assert.equal(saved.isError, true);
  assert.match(saved.content[0]?.text ?? "", /not stored/);
  assert.equal(store.paths().length, 0);
});

test("a symlinked uploaded source is refused and no path is written", async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  fs.mkdirSync(path.join(store.directory, "sources"), { recursive: true });
  const target = path.join(store.directory, "outside.md");
  fs.writeFileSync(target, "# Outside");
  fs.symlinkSync(target, path.join(store.directory, "sources", `${SOURCE_UUID}.md`));
  const saved = await tool("save_learning_path").execute("c1", uploadedDraft(SOURCE_UUID), undefined);
  assert.equal(saved.isError, true);
  assert.match(saved.content[0]?.text ?? "", /symlinked/);
  assert.equal(store.paths().length, 0);
});

test("a directory named like an uploaded source is refused and no path is written", async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  fs.mkdirSync(path.join(store.directory, "sources", `${SOURCE_UUID}.md`), { recursive: true });
  const saved = await tool("save_learning_path").execute("c1", uploadedDraft(SOURCE_UUID), undefined);
  assert.equal(saved.isError, true);
  assert.match(saved.content[0]?.text ?? "", /not a regular file/);
  assert.equal(store.paths().length, 0);
});

test("an uploaded source with mode 000 is refused and no path is written", { skip: isRoot ? "root reads any file" : false }, async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  const file = path.join(store.directory, "sources", `${SOURCE_UUID}.md`);
  store.writeSource(SOURCE_UUID, "# Locked source");
  fs.chmodSync(file, 0o000);
  try {
    const saved = await tool("save_learning_path").execute("c1", uploadedDraft(SOURCE_UUID), undefined);
    assert.equal(saved.isError, true);
    assert.match(saved.content[0]?.text ?? "", /cannot be read/);
    assert.equal(store.paths().length, 0);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test("an id with capital letters is looked up in lowercase: a file named with the capitals is refused as not stored", async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  fs.mkdirSync(path.join(store.directory, "sources"), { recursive: true });
  fs.writeFileSync(path.join(store.directory, "sources", `${CAPITAL_UUID}.md`), "# Capital source");
  if (fs.existsSync(path.join(store.directory, "sources", `${CAPITAL_UUID.toLowerCase()}.md`))) {
    t.skip("the filesystem is case-insensitive, so the capitalised name is the lowercase file");
    return;
  }
  const saved = await tool("save_learning_path").execute("c1", uploadedDraft(CAPITAL_UUID), undefined);
  assert.equal(saved.isError, true);
  assert.match(saved.content[0]?.text ?? "", /not stored/);
  assert.equal(store.paths().length, 0);
});

test("a file named with the lowercase id is accepted for an id with capital letters", async (t) => {
  const { store, tool } = upstreamDefinition(t, fakeFetch({}).fetch);
  store.writeSource(CAPITAL_UUID.toLowerCase(), "# Lowercase source");
  const saved = await tool("save_learning_path").execute("c1", uploadedDraft(CAPITAL_UUID), undefined);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  assert.equal(store.paths().length, 1);
});

/** A learner whose graph holds distinctive synthetic text, to prove none of it leaves the plugin. */
const SECRET = "ZZ-LEARNER-SECRET-7731";
function learnerContext(): PluginBackendContext {
  const graph = {
    propositions: [
      {
        id: "p1",
        name: `Topic ${SECRET}`,
        statement: `Statement ${SECRET} about the learner.`,
        aliases: [`alias ${SECRET}`],
        createdAt: "2026-01-01T00:00:00Z",
        provenance: [{ chatId: `chat-${SECRET}`, messageId: "m1" }],
      },
    ],
    chains: [],
  };
  return {
    signal: new AbortController().signal,
    learning: { graph: () => graph },
  } as unknown as PluginBackendContext;
}

const model = { provider: "synthetic", id: "synthetic-model" } as unknown as ArchitectModelConfig;

function workspace(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-architect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function upstreamDefinition(t: { after: (fn: () => void) => void }, fetch: UpstreamFetch) {
  const store = openLearningPathStore(workspace(t));
  const definition = buildArchitectDefinition(learnerContext(), model, {
    store,
    activeChatId: () => "chat-synthetic",
    upstream: { fetch, commit: COMMIT },
  });
  const tool = (name: string): { execute(id: string, params: unknown, signal: undefined): Promise<ToolResult> } => {
    const found = definition.tools?.find((candidate: PluginAgentTool) => candidate.name === name);
    assert.ok(found?.execute, `tool ${name} exists`);
    return found as unknown as { execute(id: string, params: unknown, signal: undefined): Promise<ToolResult> };
  };
  return { definition, store, tool };
}

test("upstream mode offers only the graph brief, the two upstream reads and the path tools", (t) => {
  const { definition } = upstreamDefinition(t, fakeFetch({}).fetch);
  assert.deepEqual(
    definition.tools?.map((tool) => tool.name).sort(),
    [
      "get_learning_path",
      "list_roadmap_topics",
      "read_learner_graph",
      "read_roadmap_topic",
      "save_learning_path",
      "save_learning_path_json",
    ],
  );
  for (const banned of [
    "web_search",
    "find_books",
    "book_contents",
    "read_page",
    "deep_research",
    "list_research_notes",
    "read_research_note",
    "list_uploaded_sources",
    "read_uploaded_source_chunk",
    "apply_dossier_misconceptions",
  ]) {
    assert.equal(definition.tools?.some((tool) => tool.name === banned), false, banned);
  }
});

test("the misconception-apply tool is not offered to the Architect, in upstream mode or by default", (t) => {
  const { definition } = upstreamDefinition(t, fakeFetch({}).fetch);
  assert.equal(definition.tools?.some((tool) => tool.name === "apply_dossier_misconceptions"), false);
});

test("the graph brief is read through ctx.learning.graph() and upstream calls carry no learner content", async (t) => {
  const { fetch, calls } = fakeFetch(standardRoutes());
  const { tool } = upstreamDefinition(t, fetch);
  const graph = await tool("read_learner_graph").execute("c1", {}, undefined);
  assert.equal(graph.isError, undefined);
  assert.match(graph.content[0]?.text ?? "", new RegExp(SECRET), "the model sees its own graph");

  await tool("list_roadmap_topics").execute("c2", { roadmapSlug: "synthetic-roadmap" }, undefined);
  await tool("read_roadmap_topic").execute("c3", { roadmapSlug: "synthetic-roadmap", topicSlug: "synthetic-topic" }, undefined);
  // The model could try to pass learner text as a slug: it is refused before any request.
  const refused = await tool("read_roadmap_topic").execute(
    "c4",
    { roadmapSlug: "synthetic-roadmap", topicSlug: `topic ${SECRET}` },
    undefined,
  );
  assert.equal(refused.isError, true);

  assert.equal(calls.length, 2, "one listing (reused by the topic read) and one topic file");
  for (const call of calls) {
    assert.equal(call.url.includes(SECRET), false, "no learner text in a URL");
    assert.equal(JSON.stringify(call.headers).includes(SECRET), false, "no learner text in headers");
    assert.deepEqual(Object.keys(call.headers).sort(), ["Accept", "User-Agent", "X-GitHub-Api-Version"]);
  }
});

test("a save with a link that was not read from a topic file is refused, and a copied link is saved", async (t) => {
  const { fetch } = fakeFetch(standardRoutes());
  const { tool, store } = upstreamDefinition(t, fetch);
  const draft = rawPath();
  draft.sourceSpine = {
    mode: "canonical",
    references: [{ title: "roadmap.sh developer roadmap (nilbuild/developer-roadmap)", kind: "course" }],
  };
  draft.modules[0].nodes[0].resources = [{ title: "Invented", kind: "docs", url: "https://invented.example.test/nope" }];

  const refused = await tool("save_learning_path").execute("c1", draft, undefined);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /invented\.example\.test/);
  assert.equal(store.paths().length, 0, "nothing written");

  await tool("read_roadmap_topic").execute("c2", { roadmapSlug: "synthetic-roadmap", topicSlug: "synthetic-topic" }, undefined);
  draft.modules[0].nodes[0].resources = [{ title: "Example Book", kind: "book", url: "https://books.example.test/b/1" }];
  const saved = await tool("save_learning_path").execute("c3", draft, undefined);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  assert.equal(store.paths().length, 1);
});

test("an upstream failure is returned to the Architect as an error, with no other source tried", async (t) => {
  const { fetch, calls } = fakeFetch({ [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: null });
  const { tool } = upstreamDefinition(t, fetch);
  const result = await tool("list_roadmap_topics").execute("c1", { roadmapSlug: "synthetic-roadmap" }, undefined);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /could not be reached/);
  assert.equal(calls.length, 1);
});

test("a double hyphen inside a slug is accepted; edge hyphens, traversal and bare separators are refused", async () => {
  assert.equal(assertSlug("ci--cd", "slug"), "ci--cd");
  for (const slug of ["../x", "a/b", "--x", "x--", "a..b"]) {
    assert.throws(() => assertSlug(slug, "slug"), isUpstreamError("invalid"), slug);
  }
  const { fetch, calls } = fakeFetch({});
  await assert.rejects(readTopic("synthetic-roadmap", "--x", COMMIT, { fetch }), isUpstreamError("invalid"));
  assert.equal(calls.length, 0, "no request for a refused slug");
});

test("the pinned upstream commit is a full 40-character lowercase SHA", () => {
  assert.match(UPSTREAM_PINNED_COMMIT, /^[0-9a-f]{40}$/);
});

test("dotted slugs such as node.js are accepted; traversal and path characters are refused before any request", async () => {
  for (const slug of ["node.js", "a.b-c", "nodejs", "ci-cd", "x1.y2"]) assert.equal(assertSlug(slug, "slug"), slug);
  const refused = ["..", ".", "../x", "x/../y", "a/b", "a..b", ".hidden", "node.", "x?y", "x#y", "x%2e%2e", "a\\b", "", "Node.js"];
  for (const slug of refused) assert.throws(() => assertSlug(slug, "slug"), isUpstreamError("invalid"), slug);

  const { fetch, calls } = fakeFetch({});
  for (const slug of ["../x", "a/b", ".."]) {
    await assert.rejects(listRoadmapTopics(slug, COMMIT, { fetch }), isUpstreamError("invalid"), slug);
    await assert.rejects(readTopic("synthetic-roadmap", slug, COMMIT, { fetch }), isUpstreamError("invalid"), slug);
  }
  assert.equal(calls.length, 0, "no request for a refused slug");

  const dotted = fakeFetch({
    [`${ROOT}/synthetic-roadmap/content?ref=${COMMIT}`]: { status: 200, body: JSON.stringify([{ name: "node.js@aB3_x.md" }]) },
    [`${ROOT}/synthetic-roadmap/content/node.js@aB3_x.md?ref=${COMMIT}`]: { status: 200, body: TOPIC_MD },
  });
  const topic = await readTopic("synthetic-roadmap", "node.js", COMMIT, { fetch: dotted.fetch });
  assert.equal(topic.slug, "node.js");
  assert.equal(topic.resources.length, 3);
});

test("the save guard refuses a resource title that was not read from its topic file", async (t) => {
  const { fetch } = fakeFetch(standardRoutes());
  const { tool, store } = upstreamDefinition(t, fetch);
  await tool("read_roadmap_topic").execute("c1", { roadmapSlug: "synthetic-roadmap", topicSlug: "synthetic-topic" }, undefined);
  const draft = rawPath();
  draft.sourceSpine = {
    mode: "canonical",
    references: [{ title: "roadmap.sh developer roadmap (nilbuild/developer-roadmap)", kind: "course" }],
  };

  draft.modules[0].nodes[0].resources = [{ title: "Reworded Book Title", kind: "book", url: "https://books.example.test/b/1" }];
  const refused = await tool("save_learning_path").execute("c2", draft, undefined);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /Reworded Book Title/);
  assert.equal(store.paths().length, 0, "nothing written");

  for (const title of ["@book@Example Book", "Example Book"]) {
    draft.modules[0].nodes[0].resources = [{ title, kind: "book", url: "https://books.example.test/b/1" }];
    const saved = await tool("save_learning_path").execute("c3", draft, undefined);
    assert.equal(saved.isError, undefined, `${title}: ${saved.content[0]?.text}`);
  }
  assert.equal(store.paths().length, 1);
});

test("no graph statement, goal or learner name appears in any request to GitHub", async (t) => {
  const NAME = "ZZ-LEARNER-NAME-4412";
  const GOAL = "ZZ-GOAL-PRIVATE-4412";
  const { fetch, calls } = fakeFetch(standardRoutes());
  const { tool, store } = upstreamDefinition(t, fetch);
  const draft = rawPath();
  draft.title = `${NAME} path`;
  draft.goal = `${GOAL} for ${NAME}`;
  const saved = await tool("save_learning_path").execute("c1", draft, undefined);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  assert.equal(store.paths().length, 1);

  await tool("read_learner_graph").execute("c2", {}, undefined);
  await tool("list_roadmap_topics").execute("c3", { roadmapSlug: "synthetic-roadmap" }, undefined);
  await tool("read_roadmap_topic").execute("c4", { roadmapSlug: "synthetic-roadmap", topicSlug: "synthetic-topic" }, undefined);
  assert.equal(calls.length, 2, "one listing (reused by the topic read) and one topic file");
  for (const call of calls) {
    assert.match(call.url, new RegExp(`^${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/roadmaps/`));
    for (const secret of [SECRET, GOAL, NAME]) {
      assert.equal(call.url.includes(secret), false, "no learner text in a URL");
      assert.equal(JSON.stringify(call.headers).includes(secret), false, "no learner text in headers");
    }
  }
});

test("a link a book or web tool returned may enrich a node; an invented link is still refused", async (t) => {
  const store = openLearningPathStore(workspace(t));
  const findBooks = {
    name: "find_books",
    description: "synthetic book search",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text", text: "Found: https://books.example.test/found-1." }],
      details: {},
    }),
  } as unknown as PluginAgentTool;
  const definition = buildArchitectDefinition(learnerContext(), model, {
    store,
    activeChatId: () => "chat-synthetic",
    researchTools: [findBooks],
    upstream: { fetch: fakeFetch(standardRoutes()).fetch, commit: COMMIT },
  });
  const tool = (name: string) => definition.tools?.find((candidate: PluginAgentTool) => candidate.name === name) as unknown as {
    execute(id: string, params: unknown, signal: undefined): Promise<ToolResult>;
  };
  // Books and web come last in the tool list.
  assert.equal(definition.tools?.at(-1)?.name, "find_books");

  const draft = rawPath();
  draft.sourceSpine = {
    mode: "canonical",
    references: [{ title: "roadmap.sh developer roadmap (nilbuild/developer-roadmap)", kind: "course" }],
  };
  draft.modules[0].nodes[0].resources = [{ title: "Invented", kind: "docs", url: "https://invented.example.test/nope" }];
  assert.equal((await tool("save_learning_path").execute("c1", draft, undefined)).isError, true);

  await tool("find_books").execute("c2", {}, undefined);
  draft.modules[0].nodes[0].resources = [{ title: "Found Book", kind: "book", url: "https://books.example.test/found-1" }];
  const saved = await tool("save_learning_path").execute("c3", draft, undefined);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  assert.equal(store.paths().length, 1);
});

test("the instructions put the graph and the topic files before the book and web tools", () => {
  const prompt = buildArchitectSystemPrompt({
    upstream: true,
    researchTools: ["find_books", "read_page", "list_research_notes"],
  });
  const graph = prompt.indexOf("read_learner_graph");
  const topics = prompt.indexOf("read_roadmap_topic");
  const research = prompt.indexOf("## Research");
  assert.ok(graph >= 0, "the graph is named");
  assert.ok(topics > graph, "the topic files come after the graph");
  assert.ok(research > topics, "the research section comes after the topic files");
  assert.match(prompt.slice(research), /enrich/);
  assert.match(prompt, /Books and web never create topics, nodes or roadmap structure/);
  assert.equal(prompt.includes("Do not search the web"), false, "the old ban is gone");
});

/** Issue #41: a deep_research question may not name a roadmap repo or path from memory. */
test("deep_research refuses a developer-roadmap repo other than the pinned one, or the old data/roadmaps path, and runs nothing", async (t) => {
  const store = openLearningPathStore(workspace(t));
  const questions: string[] = [];
  const deepResearch = {
    name: "deep_research",
    description: "synthetic deep research",
    parameters: { type: "object", properties: {} },
    execute: async (_id: string, params: { question: string }) => {
      questions.push(params.question);
      return { content: [{ type: "text", text: "Research note n1 saved." }], details: {} };
    },
  } as unknown as PluginAgentTool;
  const definition = buildArchitectDefinition(learnerContext(), model, {
    store,
    activeChatId: () => "chat-synthetic",
    researchTools: [deepResearch],
    upstream: { fetch: fakeFetch(standardRoutes()).fetch, commit: COMMIT },
  });
  const tool = definition.tools?.find((candidate: PluginAgentTool) => candidate.name === "deep_research") as unknown as {
    execute(id: string, params: unknown, signal: undefined): Promise<ToolResult>;
  };

  for (const question of [
    "Map the Git roadmap from github.com/example-owner/developer-roadmap",
    "Read data/roadmaps/git-github in the roadmap repo",
  ]) {
    const refused = await tool.execute("c1", { question }, undefined);
    assert.equal(refused.isError, true, question);
    assert.match(refused.content[0]!.text, new RegExp(`other than ${UPSTREAM_REPOSITORY}`));
    assert.match(refused.content[0]!.text, /list_roadmap_topics and read_roadmap_topic/);
  }
  assert.deepEqual(questions, [], "a refused question is never run");

  // The pinned repo, its own layout, other repos and plain briefs pass.
  for (const question of [
    `Best Git books; the structure is ${UPSTREAM_REPOSITORY} roadmaps/git-github/content`,
    "Find a course for github.com/git/git internals",
    "Git for a beginner who writes Python: books and courses",
  ]) {
    const passed = await tool.execute("c2", { question }, undefined);
    assert.equal(passed.isError, undefined, question);
  }
  assert.equal(questions.length, 3);
});

test("recalledRoadmapPath matches the pinned repo in any case, and leaves other text alone", () => {
  assert.equal(recalledRoadmapPath(UPSTREAM_REPOSITORY.toUpperCase()), null);
  assert.equal(recalledRoadmapPath("metadata/roadmaps and developer-roadmap alone"), null);
  assert.equal(recalledRoadmapPath("see someone/developer-roadmap/tree/master"), "someone/developer-roadmap");
});
