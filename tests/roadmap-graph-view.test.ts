/** Dependency graph view: arrows follow prerequisites, nodes stack without a cap,
 * the tree nests and collapses, cycles terminate, optional nodes are dashed, and
 * both languages carry the new strings. Layout geometry is tested, not the look. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { locale, setLocale, t } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import type { NodePrerequisites } from "../src/node-catalog-link.ts";
import { createRoadmapCanvas } from "../src/view/roadmap-canvas.ts";
import type { CanvasState } from "../src/view/roadmap-canvas.ts";
import { ROW, SUB_H, buildDependencyGraph, layoutRoadmap } from "../src/view/roadmap-layout.ts";
import { makeNode, makePath } from "./fixtures.ts";

const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};

/** One module holding the given nodes, on top of the standard fixture path. */
function pathWith(nodes: readonly PathNode[]): LearningPath {
  const modules: PathModule[] = [{ id: "module-graph", title: "Graph", nodes }];
  return { ...makePath(), modules };
}

/** Explicit prerequisites: `after` maps a node id to the ids it depends on. */
function prerequisites(after: Record<string, string[]>, nodes: readonly PathNode[]): NodePrerequisites[] {
  return nodes.map((node) => ({ nodeId: node.id, prerequisiteIds: after[node.id] ?? [], source: "catalog" as const }));
}

test("a prerequisite chain gets arrows from each prerequisite to its dependent, pointing right", () => {
  // Listed out of order on purpose: the arrows follow prerequisites, not the list.
  const nodes = [makeNode("c", "concept"), makeNode("a", "concept"), makeNode("b", "concept")];
  const path = pathWith(nodes);
  const layout = layoutRoadmap(path, {
    expandedModuleId: null,
    showOptional: true,
    prerequisites: prerequisites({ b: ["a"], c: ["b"] }, nodes),
  });
  const arrows = layout.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(arrows, ["a->b", "b->c"]);
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual([depth("a"), depth("b"), depth("c")], [0, 1, 2]);
  for (const edge of layout.edges) {
    assert.ok(edge.x1 < edge.x2, `${edge.from} -> ${edge.to} runs left to right`);
  }
});

test("a node with five children gets five arrows, and all five are placed in the next column", () => {
  const parent = makeNode("root", "concept");
  const children = ["one", "two", "three", "four", "five"].map((id) => makeNode(id, "skill"));
  const nodes = [parent, ...children];
  const after = Object.fromEntries(children.map((child) => [child.id, ["root"]]));
  const layout = layoutRoadmap(pathWith(nodes), { expandedModuleId: null, showOptional: true, prerequisites: prerequisites(after, nodes) });
  assert.equal(layout.edges.filter((edge) => edge.from === "root").length, 5);
  const placed = children.map((child) => layout.nodes.find((entry) => entry.node.id === child.id)!);
  assert.equal(placed.length, 5);
  assert.ok(placed.every((entry) => entry.depth === 1 && entry.x === placed[0]!.x));
  // Five rows in one column, no row shared.
  assert.equal(new Set(placed.map((entry) => entry.y)).size, 5);
});

test("a prerequisite cycle terminates, and exactly the edge that closes it is ignored", () => {
  const nodes = [makeNode("a", "concept"), makeNode("b", "concept"), makeNode("c", "concept"), makeNode("d", "concept")];
  const path = pathWith(nodes);
  // a needs b, b needs c, c needs a (the cycle), and d needs c.
  const prereqs = prerequisites({ a: ["b"], b: ["c"], c: ["a"], d: ["c"] }, nodes);
  const graph = buildDependencyGraph(path, { showOptional: true, prerequisites: prereqs });
  // Walk starts at a, follows a -> b -> c, then c's prerequisite a is still open: that edge (a before c) is dropped.
  assert.deepEqual(graph.ignored, [{ from: "a", to: "c" }]);
  assert.equal(graph.depth.get("c"), 0);
  assert.equal(graph.depth.get("b"), 1);
  assert.equal(graph.depth.get("d"), 1);
  assert.equal(graph.depth.get("a"), 2);
  const layout = layoutRoadmap(path, { expandedModuleId: null, showOptional: true, prerequisites: prereqs });
  assert.equal(layout.nodes.length, 4, "every node is still placed");
  assert.ok(layout.edges.every((edge) => !(edge.from === "a" && edge.to === "c")));
});

test("optional nodes get dashed arrows, and hiding one reconnects its neighbours", () => {
  const nodes = [makeNode("a", "concept"), makeNode("opt", "bridge", { optional: true }), makeNode("c", "concept")];
  const path = pathWith(nodes);
  const prereqs = prerequisites({ opt: ["a"], c: ["opt"] }, nodes);
  const shown = layoutRoadmap(path, { expandedModuleId: null, showOptional: true, prerequisites: prereqs });
  assert.deepEqual(
    shown.edges.map((edge) => [edge.from, edge.to, edge.dashed]),
    [
      ["a", "opt", true],
      ["opt", "c", true],
    ],
  );
  const hidden = layoutRoadmap(path, { expandedModuleId: null, showOptional: false, prerequisites: prereqs });
  assert.deepEqual(hidden.edges.map((edge) => [edge.from, edge.to, edge.dashed]), [["a", "c", false]]);
});

test("a column with many nodes keeps every node, stacked in rows inside the module frame", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => makeNode(`n${index}`, "skill"));
  const path = pathWith(nodes);
  const layout = layoutRoadmap(path, {
    expandedModuleId: null,
    showOptional: true,
    prerequisites: prerequisites({}, nodes),
  });
  assert.equal(layout.nodes.length, 30, "no node is dropped");
  assert.equal(new Set(layout.nodes.map((placed) => placed.y)).size, 30, "one row per node");
  const frame = layout.modules[0]!;
  for (const placed of layout.nodes) {
    assert.ok(placed.y >= frame.y && placed.y + SUB_H <= frame.y + frame.h, `${placed.node.id} is inside the frame`);
  }
  assert.ok(frame.h >= 29 * ROW + SUB_H, "the frame grows with the column");
});

test("the graph and the tree both render all five children of a node, and the tree collapses per node", () => {
  const parent = makeNode("root", "concept");
  const children = ["one", "two", "three", "four", "five"].map((id) => makeNode(id, "skill"));
  const nodes = [parent, ...children];
  const after = Object.fromEntries(children.map((child) => [child.id, ["root"]]));
  const { document } = parseHTML("<!doctype html><html><body><div id=\"host\"></div></body></html>");
  const host = document.getElementById("host") as HTMLElement;
  const controller = new AbortController();
  const canvas = createRoadmapCanvas(document as unknown as Document, host, controller.signal, {
    selectNode() {},
    toggleModule() {},
  });
  const state = (view: CanvasState["view"]): CanvasState => ({
    path: pathWith(nodes),
    selectedNodeId: null,
    expandedModuleId: null,
    view,
    showOptional: true,
    showLegend: false,
    prerequisites: prerequisites(after, nodes),
  });
  try {
    canvas.render(state("graph"));
    const graphIds = [...host.querySelectorAll<HTMLElement>(".rm-stage .rm-node")].map((node) => node.dataset.nodeId);
    for (const id of ["root", "one", "two", "three", "four", "five"]) assert.ok(graphIds.includes(id), `graph shows ${id}`);
    assert.equal(host.querySelectorAll(".rm-edges line").length >= 5, true, "five arrows are drawn");

    canvas.render(state("tree"));
    const rows = () => [...host.querySelectorAll<HTMLElement>(".rm-tree .rm-tree-row .rm-tree-node")].map((node) => node.dataset.nodeId);
    assert.deepEqual(rows(), ["root", "one", "two", "three", "four", "five"]);
    const indents = [...host.querySelectorAll<HTMLElement>(".rm-tree .rm-tree-row")].map((row) => row.style.paddingLeft);
    assert.deepEqual(indents, ["0px", "18px", "18px", "18px", "18px", "18px"]);

    // Collapse the parent's children, then expand again.
    host.querySelector<HTMLButtonElement>(".rm-tree .rm-tree-toggle")!.click();
    assert.deepEqual(rows(), ["root"]);
    host.querySelector<HTMLButtonElement>(".rm-tree .rm-tree-toggle")!.click();
    assert.equal(rows().length, 6);
  } finally {
    canvas.dispose();
    controller.abort();
  }
});

test("the new interface strings exist in both languages", () => {
  const keys: MessageKey[] = ["legend.arrow", "legend.moduleOrder", "tree.expand", "tree.collapse", "tree.alsoAfter"];
  try {
    for (const key of keys) {
      setLocale("en");
      const english = t(key, { titles: "X" });
      setLocale("ru");
      const russian = t(key, { titles: "X" });
      assert.ok(english.length > 0 && english !== key, `${key} has English`);
      assert.ok(russian.length > 0 && russian !== key, `${key} has Russian`);
    }
    setLocale("ru");
    assert.equal(t("tree.expand"), "Развернуть");
    assert.equal(locale(), "ru");
  } finally {
    setLocale("en");
  }
});
