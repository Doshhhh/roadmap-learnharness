// Gap engine on roadmap nodes (issue #7), ported from the roadmap plugin's gap-engine. Pure: no
// I/O. A node is a topic; its prerequisites come from node-catalog-link (issue #6); "covered" means
// the learner finished the node (consolidated or skipped) or the Knowledge Graph has mastery for its
// catalog topic. Fork rules: optional nodes are never gaps and never block; a group of alternatives
// (alternativeGroup) counts once; skipped counts as done.
import type { PathNode } from "./domain.ts";
import type { Mastery } from "./learner-map.ts";
import type { NodePrerequisites } from "./node-catalog-link.ts";

/** The part of a path node the gap engine reads. */
export type GapNode = Pick<PathNode, "id" | "progression" | "optional" | "alternativeGroup" | "catalogTopic">;

export type NodeGapInput = {
  /** The roadmap (learning path) the nodes belong to. Copied onto each gap. */
  roadmap: string;
  /** Nodes of the roadmap, in module order. Every node is a gap candidate unless optional. */
  nodes: readonly GapNode[];
  /** Prerequisites per node, from nodePrerequisites(). A node with no entry has none. */
  prerequisites: readonly NodePrerequisites[];
  /** Knowledge Graph evidence. A node is covered when a mastery entry carries its catalog topic slug. */
  mastery: readonly Mastery[];
};

export type NodeGap = {
  roadmap: string;
  /** The node that stands for the gap: for a group of alternatives, the first member in module order. */
  nodeId: string;
  kind: "missing" | "weak_prereq";
  /** weak_prereq only: the unseen nodes it depends on (group representatives), sorted. */
  blockedBy?: string[];
  severity: number;
  /** Set when the gap is a group of alternatives: every member id, in module order. */
  alternatives?: string[];
};

const DONE_STATES: ReadonlySet<string> = new Set(["consolidated", "skipped"]);

/**
 * Compute gaps for a roadmap. Pure: no I/O.
 *
 * Units: each node is a unit, except that nodes sharing an alternativeGroup form one unit. A unit is
 * covered when any member is done or has mastery. A unit is a gap candidate when any member is
 * required. An optional-only unit is never unseen, so it never blocks and never becomes a gap, but
 * its own prerequisites still count toward the chains above it. Prerequisites between members of
 * the same group are ignored, since alternatives are not ordered.
 *
 * Definitions (as in the reference gap engine, with units in place of topics):
 * - ancestors(u): every unit reachable from u by following prerequisite links.
 * - dependents(x): candidate units t != x with x in ancestors(t).
 * - unseenDepth(u) = max over prerequisites p of ((p unseen ? 1 : 0) + unseenDepth(p)), 0 if none.
 *
 * Gaps:
 * - missing: a candidate unit that is unseen. severity = |dependents(unit)|.
 * - weak_prereq: a covered candidate unit with at least one unseen ancestor. blockedBy = those
 *   ancestors, sorted. severity = unseenDepth(unit).
 *
 * Errors (thrown): duplicate node ids; a prerequisite or prerequisite owner that is not a node; a
 * prerequisite cycle between nodes, or between units once alternatives are collapsed. Cycles are
 * rejected because they mean the roadmap data is wrong.
 *
 * Output is sorted by severity descending, then roadmap ascending, then nodeId ascending.
 */
export function findNodeGaps(input: NodeGapInput): NodeGap[] {
  const { roadmap, nodes } = input;

  const byId = new Map<string, GapNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate node id "${node.id}"`);
    byId.set(node.id, node);
  }

  const prerequisitesOf = new Map<string, string[]>();
  for (const entry of input.prerequisites) {
    if (!byId.has(entry.nodeId)) throw new Error(`Unknown node "${entry.nodeId}" in prerequisites`);
    for (const prerequisite of entry.prerequisiteIds) {
      if (!byId.has(prerequisite)) {
        throw new Error(`Unknown prerequisite "${prerequisite}" for node "${entry.nodeId}"`);
      }
    }
    prerequisitesOf.set(entry.nodeId, [...(prerequisitesOf.get(entry.nodeId) ?? []), ...entry.prerequisiteIds]);
  }

  // Node-level cycles are rejected first, so the error names the nodes the data actually links.
  closure(nodes.map(node => node.id), id => prerequisitesOf.get(id) ?? []);

  // Collapse alternatives: each unit is keyed by its representative, the first member in module order.
  const unitOf = new Map<string, string>();
  const representativeOfGroup = new Map<string, string>();
  for (const node of nodes) {
    if (node.alternativeGroup === undefined) {
      unitOf.set(node.id, node.id);
      continue;
    }
    const representative = representativeOfGroup.get(node.alternativeGroup) ?? node.id;
    representativeOfGroup.set(node.alternativeGroup, representative);
    unitOf.set(node.id, representative);
  }

  const members = new Map<string, GapNode[]>();
  for (const node of nodes) {
    const unit = unitOf.get(node.id)!;
    members.set(unit, [...(members.get(unit) ?? []), node]);
  }
  const units = [...members.keys()];

  const unitPrerequisites = new Map<string, string[]>();
  for (const unit of units) {
    const found = new Set<string>();
    for (const member of members.get(unit)!) {
      for (const prerequisite of prerequisitesOf.get(member.id) ?? []) {
        const target = unitOf.get(prerequisite)!;
        if (target !== unit) found.add(target);
      }
    }
    unitPrerequisites.set(unit, [...found]);
  }

  const ancestors = closure(units, unit => unitPrerequisites.get(unit) ?? []);

  const masteredTopics = new Set(input.mastery.map(entry => entry.topicId));
  const isDone = (node: GapNode) =>
    DONE_STATES.has(node.progression) || (node.catalogTopic !== undefined && masteredTopics.has(node.catalogTopic.slug));
  const covered = new Set(units.filter(unit => members.get(unit)!.some(isDone)));
  const candidate = new Set(units.filter(unit => members.get(unit)!.some(node => node.optional !== true)));
  const unseen = (unit: string) => candidate.has(unit) && !covered.has(unit);

  const depthMemo = new Map<string, number>();
  const unseenDepth = (unit: string): number => {
    const memo = depthMemo.get(unit);
    if (memo !== undefined) return memo;
    let depth = 0;
    for (const prerequisite of unitPrerequisites.get(unit) ?? []) {
      depth = Math.max(depth, (unseen(prerequisite) ? 1 : 0) + unseenDepth(prerequisite));
    }
    depthMemo.set(unit, depth);
    return depth;
  };

  const candidates = units.filter(unit => candidate.has(unit));
  const gaps: NodeGap[] = [];
  for (const unit of candidates) {
    const group = members.get(unit)!;
    const alternatives = group.length > 1 ? group.map(node => node.id) : undefined;

    if (!covered.has(unit)) {
      let dependents = 0;
      for (const other of candidates) {
        if (other !== unit && ancestors.get(other)?.has(unit)) dependents++;
      }
      gaps.push({
        roadmap,
        nodeId: unit,
        kind: "missing",
        severity: dependents,
        ...(alternatives === undefined ? {} : { alternatives }),
      });
      continue;
    }

    const blockedBy = [...(ancestors.get(unit) ?? [])].filter(unseen).sort();
    if (blockedBy.length > 0) {
      gaps.push({
        roadmap,
        nodeId: unit,
        kind: "weak_prereq",
        blockedBy,
        severity: unseenDepth(unit),
        ...(alternatives === undefined ? {} : { alternatives }),
      });
    }
  }

  return gaps.sort((a, b) => b.severity - a.severity || compare(a.roadmap, b.roadmap) || compare(a.nodeId, b.nodeId));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Transitive prerequisite sets for every key. Throws on a cycle, naming the loop.
 * Keys reached through `edgesOf` but not listed in `keys` are visited too.
 */
function closure(keys: readonly string[], edgesOf: (key: string) => readonly string[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const onStack: string[] = [];
  const inStack = new Set<string>();

  const visit = (key: string): Set<string> => {
    const done = result.get(key);
    if (done) return done;
    if (inStack.has(key)) {
      const loop = [...onStack.slice(onStack.indexOf(key)), key];
      throw new Error(`Prerequisite cycle: ${loop.join(" -> ")}`);
    }
    inStack.add(key);
    onStack.push(key);
    const set = new Set<string>();
    for (const prerequisite of edgesOf(key)) {
      set.add(prerequisite);
      for (const ancestor of visit(prerequisite)) set.add(ancestor);
    }
    onStack.pop();
    inStack.delete(key);
    result.set(key, set);
    return set;
  };

  for (const key of keys) visit(key);
  return result;
}
