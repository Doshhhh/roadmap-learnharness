/** Roadmap graph layout (pure, DOM-free).
 *
 * Nodes sit in columns by dependency depth: a node is one column right of its
 * deepest prerequisite, and an arrow runs from each prerequisite to each node
 * that depends on it. Modules are bands stacked bottom-up (the first module at
 * the bottom, the path's end at the top); each band draws a frame around its
 * nodes. Any number of nodes can share a column: they stack in rows.
 *
 * Alternatives (same alternativeGroup) share a column and are bracketed. They
 * depend on the same prerequisites and never on each other.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";
import { nodePrerequisites, type NodePrerequisites } from "../node-catalog-link.ts";

export const SUB_W = 200;
export const SUB_H = 28;
export const ROW = 34;
/** Horizontal room between two columns, where the arrows run. */
export const COL_GAP = 64;
export const COL_W = SUB_W + COL_GAP;
export const MODULE_GAP = 58;
export const PAD = 40;
/** Room under the first module for the zoom control and the legend overlay. */
export const PAD_BOTTOM = 150;
export const FRAME_PAD = 12;
/** Module frame header (title, progress and source). */
export const FRAME_HEAD = 41;
/** Height of the open-error line at the foot of a module frame. */
export const ERROR_LINE = 26;
/** Distance from a node's left edge to its alternatives bracket. */
export const GROUP_BRACKET = 8;

export type NodeRole = "order" | "extra" | "consolidation";

export interface DependencyEdge {
  /** The prerequisite; the arrow starts here. */
  readonly from: string;
  /** The dependent node; the arrow ends here. */
  readonly to: string;
}

export interface DependencyGraph {
  /** Ids of the shown nodes, in path order. */
  readonly nodeIds: readonly string[];
  /** Column of each shown node: the length of its longest prerequisite chain. */
  readonly depth: ReadonlyMap<string, number>;
  /** Arrows between shown nodes. Hidden optional nodes are passed through. */
  readonly edges: readonly DependencyEdge[];
  /** Tree parent of each shown node: its deepest prerequisite (earliest in path order on a tie), or null for a root. */
  readonly parent: ReadonlyMap<string, string | null>;
  /** Prerequisite edges dropped to break cycles. */
  readonly ignored: readonly DependencyEdge[];
}

export interface PlacedNode {
  readonly node: PathNode;
  readonly moduleId: string;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

export interface PlacedModule {
  readonly module: PathModule;
  readonly index: number;
  /** The module the learner focused; drawn highlighted, and centred by focus. */
  readonly expanded: boolean;
  readonly final: boolean;
  /** Module frame rectangle. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** First unresolved error shown at the foot of the frame. */
  readonly errorLine: { readonly x: number; readonly y: number } | null;
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Dashed when either end is optional. */
  readonly dashed: boolean;
}

/** A bracket around interchangeable alternatives that sit together in one module. */
export interface AlternativeGroup {
  readonly alternativeGroup: string;
  readonly moduleId: string;
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
}

export interface RoadmapLayout {
  readonly width: number;
  readonly height: number;
  readonly modules: readonly PlacedModule[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly Edge[];
  readonly groups: readonly AlternativeGroup[];
}

export function nodeRole(node: PathNode): NodeRole {
  if (node.type === "checkpoint") return "consolidation";
  if (node.optional || node.alternativeGroup) return "extra";
  return "order";
}

export function isDone(node: PathNode): boolean {
  return node.progression === "consolidated" || node.progression === "skipped";
}

/** Progress over required work: optional nodes are not counted, and a group of
 * interchangeable alternatives counts once (done when any member is done). */
export function progressCounts(nodes: readonly PathNode[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const groups = new Map<string, boolean>();
  for (const node of nodes) {
    if (node.alternativeGroup) {
      groups.set(node.alternativeGroup, (groups.get(node.alternativeGroup) ?? false) || node.progression === "consolidated");
      continue;
    }
    if (node.optional) continue;
    total += 1;
    if (isDone(node)) done += 1;
  }
  for (const groupDone of groups.values()) {
    total += 1;
    if (groupDone) done += 1;
  }
  return { done, total };
}

export function moduleCounts(module: PathModule): { done: number; total: number } {
  return progressCounts(module.nodes);
}

/** Default expanded module: the selected node's, else the first unfinished one. */
export function defaultExpandedModule(path: LearningPath, selectedNodeId: string | null): string | null {
  if (selectedNodeId) {
    const owner = path.modules.find((module) => module.nodes.some((node) => node.id === selectedNodeId));
    if (owner) return owner.id;
  }
  const unfinished = path.modules.find((module) => module.nodes.some((node) => !node.optional && !isDone(node)));
  return (unfinished ?? path.modules[path.modules.length - 1])?.id ?? null;
}

/** Alternatives are one unit for depth: the same column, and no arrows between them. */
export function unitKey(node: PathNode): string {
  return node.alternativeGroup ? `group:${node.alternativeGroup}` : `node:${node.id}`;
}

const pairKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** Dependency depth for every shown node, the arrows between them and the tree parents.
 *
 * Prerequisites come from `prerequisites` (default: nodePrerequisites, which uses each node's own
 * prerequisites, then catalog edges, then module order).
 * A hidden optional node is passed through: its prerequisites stand in for it.
 *
 * Cycles: units are walked depth-first in path order, following prerequisites. When the
 * walk reaches a unit that is still open on the walk, the prerequisite edge it was
 * reached by is the one that closes the cycle, and it is ignored (recorded in `ignored`).
 * The result depends only on the path order, so the same roadmap always gets the same layout. */
export function buildDependencyGraph(
  path: LearningPath,
  options: { readonly showOptional: boolean; readonly prerequisites?: readonly NodePrerequisites[] },
): DependencyGraph {
  const all = path.modules.flatMap((module) => module.nodes);
  const flatIndex = new Map(all.map((node, index) => [node.id, index]));
  const prerequisiteOf = new Map(
    (options.prerequisites ?? nodePrerequisites(all, { roadmaps: [] })).map((entry) => [entry.nodeId, entry.prerequisiteIds]),
  );
  const shown = all.filter((node) => options.showOptional || !node.optional);
  const shownIds = new Set(shown.map((node) => node.id));
  const unitOf = new Map(shown.map((node) => [node.id, unitKey(node)]));

  /** Shown prerequisites of a node, passing through hidden ones; path order. */
  const shownPrerequisites = (id: string): string[] => {
    const found = new Set<string>();
    const seen = new Set<string>([id]);
    const queue = [...(prerequisiteOf.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (shownIds.has(next)) found.add(next);
      else queue.push(...(prerequisiteOf.get(next) ?? []));
    }
    return [...found].sort((a, b) => flatIndex.get(a)! - flatIndex.get(b)!);
  };

  const nodePrereqs = new Map<string, string[]>();
  const unitPrereqs = new Map<string, string[]>();
  for (const node of shown) {
    const own = shownPrerequisites(node.id);
    nodePrereqs.set(node.id, own);
    const unit = unitOf.get(node.id)!;
    const list = unitPrereqs.get(unit) ?? [];
    unitPrereqs.set(unit, list);
    for (const prerequisite of own) {
      const prerequisiteUnit = unitOf.get(prerequisite)!;
      if (prerequisiteUnit !== unit && !list.includes(prerequisiteUnit)) list.push(prerequisiteUnit);
    }
  }

  // Iterative depth-first walk over units; a back edge is ignored (see above).
  const state = new Map<string, "open" | "done">();
  const depthOfUnit = new Map<string, number>();
  const ignoredUnits = new Set<string>();
  for (const start of unitPrereqs.keys()) {
    if (state.has(start)) continue;
    state.set(start, "open");
    const frames: { unit: string; next: number }[] = [{ unit: start, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const prerequisites = unitPrereqs.get(frame.unit) ?? [];
      if (frame.next < prerequisites.length) {
        const prerequisite = prerequisites[frame.next]!;
        frame.next += 1;
        const seenState = state.get(prerequisite);
        if (seenState === "open") {
          // The prerequisite is still open on this walk, so it depends on frame.unit: this edge closes the cycle.
          ignoredUnits.add(pairKey(prerequisite, frame.unit));
        } else if (seenState === undefined) {
          state.set(prerequisite, "open");
          frames.push({ unit: prerequisite, next: 0 });
        }
        continue;
      }
      let depth = 0;
      for (const prerequisite of prerequisites) {
        if (ignoredUnits.has(pairKey(prerequisite, frame.unit))) continue;
        depth = Math.max(depth, (depthOfUnit.get(prerequisite) ?? 0) + 1);
      }
      depthOfUnit.set(frame.unit, depth);
      state.set(frame.unit, "done");
      frames.pop();
    }
  }

  const edges: DependencyEdge[] = [];
  const ignored: DependencyEdge[] = [];
  for (const node of shown) {
    const unit = unitOf.get(node.id)!;
    for (const prerequisite of nodePrereqs.get(node.id) ?? []) {
      const prerequisiteUnit = unitOf.get(prerequisite)!;
      if (prerequisiteUnit === unit) continue;
      const edge = { from: prerequisite, to: node.id };
      if (ignoredUnits.has(pairKey(prerequisiteUnit, unit))) ignored.push(edge);
      else edges.push(edge);
    }
  }

  const depth = new Map(shown.map((node) => [node.id, depthOfUnit.get(unitOf.get(node.id)!) ?? 0]));
  // The deepest kept prerequisite sits exactly one level up, so the tree indents one level per depth.
  const incomingByUnit = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const unit = unitOf.get(edge.to)!;
    incomingByUnit.set(unit, [...(incomingByUnit.get(unit) ?? []), edge]);
  }
  const parent = new Map<string, string | null>();
  for (const node of shown) {
    let best: string | null = null;
    for (const edge of incomingByUnit.get(unitOf.get(node.id)!) ?? []) {
      if (best === null) best = edge.from;
      else if (depth.get(edge.from)! > depth.get(best)!) best = edge.from;
      else if (depth.get(edge.from) === depth.get(best) && flatIndex.get(edge.from)! < flatIndex.get(best)!) best = edge.from;
    }
    parent.set(node.id, best);
  }

  return { nodeIds: shown.map((node) => node.id), depth, edges, parent, ignored };
}

const stackHeight = (count: number): number => (count === 0 ? 0 : (count - 1) * ROW + SUB_H);

export function layoutRoadmap(
  path: LearningPath,
  options: { readonly expandedModuleId: string | null; readonly showOptional: boolean; readonly prerequisites?: readonly NodePrerequisites[] },
): RoadmapLayout {
  const graph = buildDependencyGraph(path, options);
  const all = path.modules.flatMap((module) => module.nodes);
  const flatIndex = new Map(all.map((node, index) => [node.id, index]));
  const firstOfUnit = new Map<string, number>();
  for (const node of all) {
    const key = unitKey(node);
    if (!firstOfUnit.has(key)) firstOfUnit.set(key, flatIndex.get(node.id)!);
  }
  const columns = graph.nodeIds.length === 0 ? 0 : Math.max(...graph.depth.values()) + 1;
  const colX = (depth: number): number => PAD + FRAME_PAD + depth * COL_W;

  interface Band {
    readonly module: PathModule;
    readonly index: number;
    readonly cells: Map<number, PathNode[]>;
    readonly hasError: boolean;
    readonly height: number;
  }
  const bands: Band[] = path.modules.map((module, index) => {
    const cells = new Map<number, PathNode[]>();
    for (const node of module.nodes) {
      const depth = graph.depth.get(node.id);
      if (depth === undefined) continue;
      cells.set(depth, [...(cells.get(depth) ?? []), node]);
    }
    // Alternatives of one unit stay adjacent within a column, in path order.
    for (const list of cells.values()) {
      list.sort((a, b) => firstOfUnit.get(unitKey(a))! - firstOfUnit.get(unitKey(b))! || flatIndex.get(a.id)! - flatIndex.get(b.id)!);
    }
    const rows = Math.max(0, ...[...cells.values()].map((list) => list.length));
    const hasError = module.nodes.some((node) => node.errors.some((entry) => !entry.resolved));
    const height = FRAME_HEAD + (rows > 0 ? stackHeight(rows) + FRAME_PAD : FRAME_PAD) + (hasError ? ERROR_LINE : 0);
    return { module, index, cells, hasError, height };
  });

  const right = columns > 0 ? colX(columns - 1) + SUB_W : PAD + FRAME_PAD + SUB_W;
  const width = right + FRAME_PAD + PAD;
  const height = PAD + PAD_BOTTOM + bands.reduce((sum, band) => sum + band.height, 0) + MODULE_GAP * Math.max(0, bands.length - 1);

  const modules: PlacedModule[] = [];
  const nodes: PlacedNode[] = [];
  const groups: AlternativeGroup[] = [];
  let bottom = height - PAD_BOTTOM;

  for (const band of bands) {
    const top = bottom - band.height;
    const depths = [...band.cells.keys()];
    const frameX = depths.length > 0 ? colX(Math.min(...depths)) - FRAME_PAD : PAD;
    const frameRight = depths.length > 0 ? colX(Math.max(...depths)) + SUB_W + FRAME_PAD : PAD + SUB_W + 2 * FRAME_PAD;
    const errorLine = band.hasError ? { x: frameX + FRAME_PAD, y: top + band.height - FRAME_PAD - 20 } : null;
    modules.push({
      module: band.module,
      index: band.index,
      expanded: band.module.id === options.expandedModuleId,
      final: band.index === bands.length - 1 && bands.length > 1,
      x: frameX,
      y: top,
      w: frameRight - frameX,
      h: band.height,
      errorLine,
    });
    for (const [depth, list] of band.cells) {
      const x = colX(depth);
      list.forEach((node, row) => {
        nodes.push({ node, moduleId: band.module.id, depth, x, y: top + FRAME_HEAD + row * ROW, w: SUB_W });
      });
      // Bracket each run of two or more adjacent members of one alternative group.
      let runStart = 0;
      for (let row = 1; row <= list.length; row += 1) {
        if (row < list.length && unitKey(list[row]!) === unitKey(list[runStart]!)) continue;
        const first = list[runStart]!;
        if (first.alternativeGroup && row - runStart >= 2) {
          groups.push({
            alternativeGroup: first.alternativeGroup,
            moduleId: band.module.id,
            x: x - GROUP_BRACKET,
            y1: top + FRAME_HEAD + runStart * ROW,
            y2: top + FRAME_HEAD + (row - 1) * ROW + SUB_H,
          });
        }
        runStart = row;
      }
    }
    bottom = top - MODULE_GAP;
  }

  const placedNodes = new Map(nodes.map((placed) => [placed.node.id, placed]));
  const edges: Edge[] = [];
  for (const edge of graph.edges) {
    const from = placedNodes.get(edge.from);
    const to = placedNodes.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      x1: from.x + from.w,
      y1: from.y + SUB_H / 2,
      x2: to.x,
      y2: to.y + SUB_H / 2,
      dashed: Boolean(from.node.optional || to.node.optional),
    });
  }

  return { width, height, modules, nodes, edges, groups };
}
