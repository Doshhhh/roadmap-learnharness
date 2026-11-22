// Next-node recommendation inside a roadmap (issue #9), ported from the roadmap plugin's recommender
// and adapted to path nodes. Pure: no I/O, no clock. Nothing is gated: this only ranks nodes, and any
// node can still be opened. Reasons are i18n keys with variables; the view translates them.
import type { LearningPath, PathNode } from "./domain.ts";
import type { MessageKey } from "./i18n.ts";
import type { Mastery } from "./learner-map.ts";
import { nodePrerequisites, type NodePrerequisites } from "./node-catalog-link.ts";
import { findNodeGaps, type NodeGap } from "./node-gaps.ts";

/** How many nodes the "Next up" list shows at most. */
export const NEXT_LIMIT = 3;

/** Every reason key this module can emit, so a test can check both locales carry them. */
export const NEXT_REASON_KEYS: readonly MessageKey[] = [
  "next.noPrereqs",
  "next.prereqsDone",
  "next.inProgress",
  "next.blocks",
  "next.direct",
  "next.errors",
];

/** The part of a path node the ranking reads. */
export type NextNode = Pick<PathNode, "id" | "progression" | "optional" | "alternativeGroup" | "errors">;

export type NextReason = { key: MessageKey; vars?: Record<string, number> };

export type NextRecommendation = {
  /** The node to open. For a group of alternatives, the first member in module order. */
  nodeId: string;
  score: number;
  reasons: NextReason[];
};

export type NextInput = {
  /** Nodes of one roadmap, in module order. */
  nodes: readonly NextNode[];
  /** Prerequisites per node, from nodePrerequisites(). A node with no entry has none. */
  prerequisites: readonly NodePrerequisites[];
  /** Gaps for the same roadmap, from findNodeGaps(). Only "missing" gaps add severity. */
  gaps: readonly NodeGap[];
  /** Maximum number of recommendations. Default NEXT_LIMIT. */
  limit?: number;
};

const DONE: ReadonlySet<string> = new Set(["consolidated", "skipped"]);

/**
 * Ranked next nodes. Pure.
 *
 * Units: as in findNodeGaps, nodes sharing an alternativeGroup form one unit, done when any member
 * is done. Only required units (at least one member not optional) are candidates.
 *
 * Ready: a candidate that is not done and whose required prerequisite units are all done. Optional
 * prerequisites never block.
 *
 * Score = severity + dependents + openErrors, all weighted 1, where
 * - severity is the gap severity of the unit's "missing" gap (transitive dependents, from findNodeGaps),
 *   0 when there is none,
 * - dependents counts the required, not-done units that list this unit as a direct prerequisite,
 * - openErrors counts unresolved errors on the unit's members.
 *
 * Reasons, in order: "no required prerequisites" or "all required prerequisites are done"; "already in
 * progress" when a member is in progress; "downstream nodes it blocks: N" when severity > 0; "prerequisite
 * for N nodes" when dependents > 0; "open errors: N" when openErrors > 0.
 *
 * Order: score desc, then nodeId asc (the reference tie order). Returns at most `limit` entries.
 * Throws on an invalid limit, a duplicate node id, or a prerequisite that is not a node.
 */
export function rankNextNodes(input: NextInput): NextRecommendation[] {
  const limit = input.limit ?? NEXT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid limit ${limit}`);

  const byId = new Map<string, NextNode>();
  for (const node of input.nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate node id "${node.id}"`);
    byId.set(node.id, node);
  }

  const unitOf = new Map<string, string>();
  const firstOfGroup = new Map<string, string>();
  for (const node of input.nodes) {
    if (node.alternativeGroup === undefined) {
      unitOf.set(node.id, node.id);
      continue;
    }
    const first = firstOfGroup.get(node.alternativeGroup) ?? node.id;
    firstOfGroup.set(node.alternativeGroup, first);
    unitOf.set(node.id, first);
  }

  const members = new Map<string, NextNode[]>();
  for (const node of input.nodes) {
    const unit = unitOf.get(node.id)!;
    members.set(unit, [...(members.get(unit) ?? []), node]);
  }
  const units = [...members.keys()];

  const prerequisitesOf = new Map<string, string[]>();
  for (const entry of input.prerequisites) {
    for (const prerequisite of entry.prerequisiteIds) {
      if (!byId.has(prerequisite)) throw new Error(`Unknown prerequisite "${prerequisite}" for node "${entry.nodeId}"`);
    }
    prerequisitesOf.set(entry.nodeId, [...(prerequisitesOf.get(entry.nodeId) ?? []), ...entry.prerequisiteIds]);
  }

  const unitPrerequisites = new Map<string, Set<string>>();
  for (const unit of units) {
    const found = new Set<string>();
    for (const member of members.get(unit)!) {
      for (const prerequisite of prerequisitesOf.get(member.id) ?? []) {
        const target = unitOf.get(prerequisite)!;
        if (target !== unit) found.add(target);
      }
    }
    unitPrerequisites.set(unit, found);
  }

  const isDone = (unit: string) => members.get(unit)!.some(node => DONE.has(node.progression));
  const isRequired = (unit: string) => members.get(unit)!.some(node => node.optional !== true);
  const openRequired = units.filter(unit => isRequired(unit) && !isDone(unit));

  const severityOf = new Map<string, number>();
  for (const gap of input.gaps) {
    if (gap.kind === "missing") severityOf.set(gap.nodeId, gap.severity);
  }

  const ready = openRequired.filter(unit =>
    [...unitPrerequisites.get(unit)!].every(prerequisite => isDone(prerequisite) || !isRequired(prerequisite)),
  );

  const scored = ready.map(unit => {
    const group = members.get(unit)!;
    const severity = severityOf.get(unit) ?? 0;
    const dependents = openRequired.filter(other => other !== unit && unitPrerequisites.get(other)!.has(unit)).length;
    const openErrors = group.reduce((sum, node) => sum + node.errors.filter(entry => !entry.resolved).length, 0);
    const requiredPrerequisites = [...unitPrerequisites.get(unit)!].filter(isRequired);

    const reasons: NextReason[] = [
      requiredPrerequisites.length === 0 ? { key: "next.noPrereqs" } : { key: "next.prereqsDone" },
    ];
    if (group.some(node => node.progression === "in_progress")) reasons.push({ key: "next.inProgress" });
    if (severity > 0) reasons.push({ key: "next.blocks", vars: { n: severity } });
    if (dependents > 0) reasons.push({ key: "next.direct", vars: { n: dependents } });
    if (openErrors > 0) reasons.push({ key: "next.errors", vars: { n: openErrors } });

    return { nodeId: unit, score: severity + dependents + openErrors, reasons };
  });

  return scored
    .sort((a, b) => b.score - a.score || compare(a.nodeId, b.nodeId))
    .slice(0, limit);
}

/**
 * Next nodes for a roadmap as the view has it. The view has no catalog, so prerequisites are each
 * node's own (issue #44), else module order (nodePrerequisites with an empty catalog). `mastery` is
 * the Knowledge Graph mastery (default empty). Throws on the same data errors as findNodeGaps.
 */
export function nextUpForPath(path: LearningPath, limit: number = NEXT_LIMIT, mastery: readonly Mastery[] = []): NextRecommendation[] {
  const nodes = path.modules.flatMap(module => module.nodes);
  const prerequisites = nodePrerequisites(nodes, { roadmaps: [] });
  const gaps = findNodeGaps({ roadmap: path.id, nodes, prerequisites, mastery });
  return rankNextNodes({ nodes, prerequisites, gaps, limit });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
