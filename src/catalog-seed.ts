// Catalog topics as input for new roadmaps (seed outline) and for existing roadmaps (pivot
// proposals) — issue #10. Pure: no I/O, no model client, no clock. Nothing here inserts a node;
// the caller decides what to do with the outline or the proposals.
import type { CatalogTopicLink, PivotSuggestion, PathNode } from "./domain.ts";

/** A catalog roadmap reduced to what seeding reads. Any real CatalogRoadmap is assignable to it. */
export type SeedRoadmap = {
  slug: string;
  title: string;
  topics: { slug: string; title: string }[];
};

/** One module-like group of the starting outline, topics in catalog order. */
export type SeedGroup = {
  title: string;
  topics: { slug: string; title: string }[];
};

/** A plain outline for the Architect to start from. Data only, no prompt text. */
export type CatalogSeed = {
  roadmap: string;
  title: string;
  groups: SeedGroup[];
};

/** A catalog frontier topic, tagged with the roadmap it belongs to. */
export type FrontierTopic = { roadmap: string; slug: string; title: string };

/** The part of a path node that linking reads. Any PathNode is assignable to it. */
export type LinkableNode = Pick<PathNode, "id" | "catalogTopic">;

/**
 * Outline a matched catalog roadmap as a starting brief. The catalog has no module structure, so
 * the topics form one group, in catalog order. Topic order is kept exactly as given.
 */
export function seedFromCatalogRoadmap(roadmap: SeedRoadmap): CatalogSeed {
  return {
    roadmap: roadmap.slug,
    title: roadmap.title,
    groups: [
      {
        title: roadmap.title,
        topics: roadmap.topics.map(topic => ({ slug: topic.slug, title: topic.title })),
      },
    ],
  };
}

function sameTopic(link: CatalogTopicLink | undefined, roadmap: string, slug: string): boolean {
  return link !== undefined && link.roadmap === roadmap && link.slug === slug;
}

/**
 * One pending pivot proposal per frontier topic that no existing node covers (matched by the
 * node's catalogTopic link on both roadmap and slug). Proposal text comes from the catalog topic
 * title. Proposals are never applied: `status` is "pending" and there is no `insertedNodeId`.
 * Output follows frontier order; the proposal id is derived from the topic, so repeated calls
 * produce the same ids.
 */
export function frontierPivots(
  frontier: readonly FrontierTopic[],
  existingNodes: readonly LinkableNode[],
  createdAt: string,
): PivotSuggestion[] {
  return frontier
    .filter(
      topic =>
        !existingNodes.some(node => sameTopic(node.catalogTopic, topic.roadmap, topic.slug)),
    )
    .map(topic => ({
      id: `pivot-catalog-${topic.roadmap}-${topic.slug}`,
      status: "pending" as const,
      proposalType: "bridge" as const,
      title: topic.title,
      rationale: `Your learning map has not covered "${topic.title}" yet, and no node on this path covers it.`,
      createdAt,
    }));
}
