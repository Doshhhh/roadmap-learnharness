/** Node prerequisites (issue #44): validation, the module-order fallback for old data, the
 * Architect's draft, and the graph and tree with several roots. Synthetic fixtures only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DRAFT_ID_PREFIX, completeDraft, replaceDraftIds } from "../src/architect-agent.ts";
import { nextUpForPath } from "../src/node-next.ts";
import { parseLearningPath, validateLearningPath } from "../src/domain.ts";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { nodePrerequisites } from "../src/node-catalog-link.ts";
import type { EdgeCatalogView, LinkedNode } from "../src/node-catalog-link.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { layoutRoadmap, buildDependencyGraph } from "../src/view/roadmap-layout.ts";
import { setLocale, t } from "../src/i18n.ts";
import { makeNode, makePath, rawPath } from "./fixtures.ts";
import { createHost } from "./host.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};

const NO_CATALOG: EdgeCatalogView = { roadmaps: [] };

/** A path whose one module holds the given nodes. */
function pathWith(nodes: readonly PathNode[]): LearningPath {
  const modules: PathModule[] = [{ id: "module-graph", title: "Graph", nodes }];
  return { ...makePath(), modules };
}

/** The issues of a path draft that fails validation, or an empty list when it passes. */
function issuesOf(path: LearningPath): string[] {
  const result = validateLearningPath(path);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/** A path with the given node prerequisites set on its first module's nodes, by node id. */
function withPrerequisites(path: LearningPath, after: Record<string, readonly string[] | undefined>): LearningPath {
  return {
    ...path,
    modules: path.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) =>
        node.id in after ? { ...node, prerequisites: after[node.id] } : node,
      ) as PathNode[],
    })),
  };
}

test("validation accepts prerequisites that exist in the roadmap, an empty list, and old data without the field", () => {
  const base = pathWith([makeNode("a", "concept"), makeNode("b", "concept"), makeNode("c", "concept")]);
  const chained = withPrerequisites(base, { b: ["a"], c: ["a", "b"] });
  assert.deepEqual(issuesOf(chained), []);
  assert.deepEqual(issuesOf(withPrerequisites(base, { a: [], b: [] })), [], "an empty list is a root");
  assert.deepEqual(issuesOf(base), [], "old data without prerequisites still validates");
  const parsed = parseLearningPath(chained);
  assert.deepEqual(parsed.modules[0]!.nodes.map((node) => node.prerequisites), [undefined, ["a"], ["a", "b"]]);
});

test("validation refuses an unknown id, a self reference, a duplicate and a cycle, each with a plain message", () => {
  const base = pathWith([makeNode("a", "concept"), makeNode("b", "concept")]);
  const unknown = issuesOf(withPrerequisites(base, { b: ["ghost"] }));
  assert.equal(unknown.length, 1);
  assert.match(unknown[0]!, /node "b"\.prerequisites: unknown node id "ghost"/);

  const self = issuesOf(withPrerequisites(base, { b: ["b"] }));
  assert.match(self[0]!, /node "b"\.prerequisites: must not depend on the node itself/);

  const duplicate = validateLearningPath(withPrerequisites(base, { b: ["a", "a"] }));
  assert.equal(duplicate.ok, false);

  const cyclic = issuesOf(withPrerequisites(pathWith([makeNode("a", "concept"), makeNode("b", "concept"), makeNode("c", "concept")]), {
    a: ["b"],
    b: ["c"],
    c: ["a"],
  }));
  assert.equal(cyclic.length, 1);
  assert.equal(cyclic[0], "path.modules: prerequisites form a cycle: a -> b -> c -> a");
});

test("nodePrerequisites uses a node's own prerequisites, an empty list is a root, and old data falls back to module order", () => {
  const nodes: LinkedNode[] = [
    { id: "n-first" },
    { id: "n-own", prerequisites: ["n-first"] },
    { id: "n-root", prerequisites: [] },
    { id: "n-old" },
  ];
  const byId = new Map(nodePrerequisites(nodes, NO_CATALOG).map((entry) => [entry.nodeId, entry]));
  assert.deepEqual(byId.get("n-own"), { nodeId: "n-own", prerequisiteIds: ["n-first"], source: "node" });
  assert.deepEqual(byId.get("n-root"), { nodeId: "n-root", prerequisiteIds: [], source: "node" });
  assert.deepEqual(byId.get("n-old"), { nodeId: "n-old", prerequisiteIds: ["n-root"], source: "module-order" });
  assert.deepEqual(byId.get("n-first"), { nodeId: "n-first", prerequisiteIds: [], source: "module-order" });
});

test("a path without any prerequisites lays out in module order, as before", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "concept"), makeNode("c", "concept")];
  const layout = layoutRoadmap(pathWith(nodes), { expandedModuleId: null, showOptional: true });
  assert.deepEqual(layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(), ["a->b", "b->c"]);
});

test("the graph draws arrows from each prerequisite and starts a branch at every node without one", () => {
  const nodes = [
    makeNode("a", "concept"),
    makeNode("b", "concept", { prerequisites: [] }),
    makeNode("c", "skill", { prerequisites: ["a"] }),
    makeNode("d", "skill", { prerequisites: ["a", "b"] }),
  ];
  const path = pathWith(nodes);
  const layout = layoutRoadmap(path, { expandedModuleId: null, showOptional: true });
  assert.deepEqual(
    layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort(),
    ["a->c", "a->d", "b->d"],
  );
  const graph = buildDependencyGraph(path, { showOptional: true });
  assert.equal(graph.parent.get("a"), null);
  assert.equal(graph.parent.get("b"), null);
  // a and b are both at depth 0, so the tie goes to the earlier node in path order.
  assert.equal(graph.parent.get("d"), "a", "the tree nests under the deepest prerequisite, earliest on a tie");
});

test("a roadmap with two roots draws both branches and the tree shows both roots at level 0", () => {
  const nodes = [
    makeNode("root-one", "concept", { prerequisites: [] }),
    makeNode("root-two", "concept", { prerequisites: [] }),
    makeNode("after-one", "skill", { prerequisites: ["root-one"] }),
    makeNode("after-two", "skill", { prerequisites: ["root-two"] }),
  ];
  const path = pathWith(nodes);
  const graph = buildDependencyGraph(path, { showOptional: true });
  assert.deepEqual(
    [...graph.parent.entries()].filter(([, parent]) => parent === null).map(([id]) => id),
    ["root-one", "root-two"],
  );

  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const state = (view: CanvasState["view"]): CanvasState => ({
    path,
    selectedNodeId: null,
    expandedModuleId: null,
    view,
    showOptional: true,
    showLegend: false,
  });
  try {
    canvas.render(state("tree"));
    const rows = [...host.querySelectorAll<HTMLElement>(".rm-tree .rm-tree-row")];
    const level0 = rows.filter((row) => row.style.paddingLeft === "0px").map((row) => row.querySelector<HTMLElement>(".rm-tree-node")!.dataset.nodeId);
    assert.deepEqual(level0, ["root-one", "root-two"]);

    canvas.render(state("graph"));
    const graphIds = [...host.querySelectorAll<HTMLElement>(".rm-stage .rm-node")].map((node) => node.dataset.nodeId);
    for (const id of ["root-one", "root-two", "after-one", "after-two"]) assert.ok(graphIds.includes(id), `graph shows ${id}`);
    assert.equal(host.querySelectorAll(".rm-edges line").length, 2, "two arrows, one per branch");
  } finally {
    canvas.dispose();
    controller.abort();
  }
});

test("the Architect's draft keeps prerequisites that exist in the draft and drops unknown ids", () => {
  const existing = makePath();
  const [first, second] = existing.modules[0]!.nodes;
  const target = existing.modules[1]!.nodes[0]!;
  const draft = {
    ...existing,
    modules: existing.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) => {
        if (node.id === target.id) return { ...node, prerequisites: [first!.id, "ghost-node", first!.id] };
        return { ...node };
      }),
    })),
  };
  const completed = completeDraft(draft as unknown as Record<string, unknown>, existing, "chat-synthetic", null);
  const parsed = parseLearningPath(completed);
  const kept = parsed.modules.flatMap((module) => module.nodes).find((node) => node.id === target.id)!;
  assert.deepEqual(kept.prerequisites, [first!.id], "the unknown id is dropped and the repeat is merged");
  assert.equal(
    parsed.modules.flatMap((module) => module.nodes).find((node) => node.id === second!.id)!.prerequisites,
    undefined,
    "a node the draft says nothing about keeps no prerequisites",
  );
});

test("the legend names prerequisites once any node sets them, in both languages, and module order until then", () => {
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const legendNote = (nodes: PathNode[]): string => {
    canvas.render({
      path: { ...makePath(), modules: [{ id: "m", title: "M", nodes }] },
      selectedNodeId: null,
      expandedModuleId: null,
      view: "graph",
      showOptional: true,
      showLegend: true,
    });
    return host.querySelector(".rm-legend .rm-legend-note")!.textContent ?? "";
  };
  try {
    setLocale("en");
    assert.equal(legendNote([makeNode("a", "concept")]), t("legend.moduleOrder"));
    assert.equal(legendNote([makeNode("a", "concept", { prerequisites: [] })]), t("legend.prerequisitesNote"));
    setLocale("ru");
    assert.equal(legendNote([makeNode("a", "concept", { prerequisites: [] })]), t("legend.prerequisitesNote"));
    assert.notEqual(t("legend.prerequisitesNote"), "legend.prerequisitesNote");
  } finally {
    setLocale("en");
    controller.abort();
  }
});

test("the Architect's draft refuses a cycle with the plain message", () => {
  const existing = rawPath();
  const nodes = existing.modules.flatMap((module: PathModule) => module.nodes) as PathNode[];
  const [a, b] = nodes;
  const draft = {
    ...existing,
    modules: existing.modules.map((module: PathModule) => ({
      ...module,
      nodes: module.nodes.map((node: PathNode) => {
        if (node.id === a!.id) return { ...node, prerequisites: [b!.id] };
        if (node.id === b!.id) return { ...node, prerequisites: [a!.id] };
        return { ...node };
      }),
    })),
  };
  const completed = completeDraft(draft as unknown as Record<string, unknown>, existing, "chat-synthetic", null);
  const result = validateLearningPath(completed);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues[0]!.message, /prerequisites form a cycle/);
});

/** A new-path draft as the model writes it: no ids except the given draft ids. */
function newDraft(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    title: "Synthetic draft",
    goal: "Exercise draft ids",
    createdAt: "2026-01-31T09:30:00.000Z",
    updatedAt: "2026-01-31T09:30:00.000Z",
    sourceSpine: { mode: "canonical", references: [{ title: "Synthetic Book", kind: "textbook" }] },
    modules: [{ title: "Only", nodes: nodes.map((node) => ({
      type: "concept", goal: "Synthetic goal", sourceAnchor: { reference: "Synthetic Book" }, ...node,
    })) }],
  };
}

test("draft ids link new nodes inside one draft and are replaced by server ids on save", () => {
  const draft = newDraft([
    { id: "draft:basics", title: "Basics", prerequisites: [] },
    { id: "draft:other-root", title: "Other root", prerequisites: [] },
    { title: "Needs both", prerequisites: ["draft:basics", "draft:other-root", "draft:ghost"] },
  ]);
  const validated = parseLearningPath(completeDraft(draft, null, "chat-synthetic", null));
  const saved = parseLearningPath(replaceDraftIds(validated, null));
  const [basics, otherRoot, needsBoth] = saved.modules[0]!.nodes;
  const serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes(DRAFT_ID_PREFIX), "no draft id survives the save");
  assert.match(basics!.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(needsBoth!.prerequisites, [basics!.id, otherRoot!.id], "references follow the new ids; the unknown one is dropped");
  assert.deepEqual(needsBoth!.interleavesNodeIds, [basics!.id, otherRoot!.id], "default interleaving follows them too");
});

test("a draft id never replaces or points at a stored node", () => {
  const existing = pathWith([makeNode("a", "concept"), makeNode("b", "concept")]);
  const draft = {
    ...existing,
    modules: existing.modules.map((module) => ({
      ...module,
      nodes: [
        ...module.nodes.map((node) => ({ ...node, prerequisites: [] })),
        { id: "draft:a", type: "concept", title: "New", goal: "New goal", sourceAnchor: { reference: "OSTEP" }, prerequisites: ["a"] },
      ],
    })),
  };
  const saved = parseLearningPath(replaceDraftIds(parseLearningPath(completeDraft(draft as never, existing, "chat-synthetic", null)), existing));
  const ids = saved.modules[0]!.nodes.map((node) => node.id);
  assert.deepEqual(ids.slice(0, 2), ["a", "b"], "stored ids are kept");
  assert.notEqual(ids[2], "a");
  assert.match(ids[2]!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(saved.modules[0]!.nodes[2]!.prerequisites, ["a"]);
});

test("a draft that gives some new nodes prerequisites must give them to every new node; none at all keeps module order", () => {
  const mixed = newDraft([
    { title: "Root", prerequisites: [] },
    { title: "Forgot" },
  ]);
  assert.throws(() => completeDraft(mixed, null, "chat-synthetic", null), /Every new node needs prerequisites[^]*"Forgot"/);

  const none = newDraft([{ title: "First" }, { title: "Second" }]);
  const saved = parseLearningPath(completeDraft(none, null, "chat-synthetic", null));
  assert.deepEqual(saved.modules[0]!.nodes.map((node) => node.prerequisites), [undefined, undefined]);
  const layout = layoutRoadmap(saved, { expandedModuleId: null, showOptional: true });
  assert.equal(layout.edges.length, 1, "falls back to module order, as old data does");
});

test("next-up follows a node's own prerequisites, not module order", () => {
  const path = pathWith([
    makeNode("a", "concept", { prerequisites: [], progression: "consolidated" }),
    makeNode("b", "concept", { prerequisites: [] }),
    makeNode("c", "skill", { prerequisites: ["a"] }),
  ]);
  const next = nextUpForPath(path).map((entry) => entry.nodeId);
  assert.ok(next.includes("c"), "c needs only a, which is done; module order would have made it wait for b");
  assert.ok(next.includes("b"));
});

test("save_learning_path stores server ids in place of draft ids, with the prerequisites rewritten", async (t) => {
  const h = createHost({});
  t.after(() => h.close());
  await h.call("architect.create");
  const draft = newDraft([
    { id: "draft:root", title: "Root", prerequisites: [] },
    { id: "draft:next", title: "Next", prerequisites: ["draft:root"] },
  ]);
  const saved = await h.runTool<{ isError?: boolean; details: { pathId: string }; content: { text: string }[] }>("save_learning_path", draft);
  assert.equal(saved.isError, undefined, saved.content[0]?.text);
  const { path } = await h.call<{ path: LearningPath }>("paths.get", { id: saved.details.pathId });
  const [root, next] = path.modules[0]!.nodes;
  assert.ok(!JSON.stringify(path).includes(DRAFT_ID_PREFIX));
  assert.deepEqual(next!.prerequisites, [root!.id]);
});
