// Link roadmap nodes to roadmap.sh catalog topics (issue #6), and derive node prerequisites from
// catalog edges. Pure: no I/O, no model client. Deterministic word overlap proposes topics; an
// injected model pass may choose among those candidates. Its answer is validated, and any failure
// falls back to the deterministic result. Nothing is linked without word evidence.
import type { CatalogTopicLink } from "./domain.ts";
import type { CatalogView } from "./catalog-match.ts";

/** The text of a node that the link is computed from. */
export type NodeText = { title: string; goal: string; outcomes?: readonly string[] };

/** A catalog topic whose words overlap the node. `score` is the share of its words the node covers. */
export type TopicCandidate = { roadmap: string; slug: string; title: string; score: number };

/** The model's answer: one candidate topic and a short reason. */
export type LinkPick = { roadmap: string; slug: string; reason: string };

/**
 * Injected model pass. Receives the node and its deterministic candidates, and resolves to the
 * model's pick, or null when it gave no answer. A rejected promise is a failed call.
 */
export type LinkRerank = (node: NodeText, candidates: TopicCandidate[]) => Promise<LinkPick | null>;

export type TopicLinkProposal = {
  link: CatalogTopicLink;
  title: string;
  /** "model" when a validated model pick was used, "deterministic" for a unique top candidate. */
  source: "model" | "deterministic";
  reason: string;
};

export type TopicLinkResult = {
  /** The proposed topic, or null when nothing clears the threshold or the top candidates tie. */
  proposal: TopicLinkProposal | null;
  /** Deterministic candidates at or above the threshold, best first. */
  candidates: TopicCandidate[];
  /** "not-called": no candidates, or no model pass given. */
  modelOutcome: "not-called" | "accepted" | "invalid" | "failed";
};

/** A topic needs at least this share of its significant words to appear in the node. */
export const MIN_LINK_SCORE = 0.6;
export const DEFAULT_LINK_TOP_N = 5;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "your", "you", "can", "will",
  "use", "using", "how", "what", "about", "after", "before", "learn", "understand", "build",
  "make", "know", "knowing", "are", "its", "not", "all", "any", "one", "when", "why", "over",
]);

/** Lowercase words of three or more letters, minus stopwords, with a plain plural fold. */
export function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOPWORDS.has(word))
    .map(word => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return new Set(words);
}

function nodeWords(node: NodeText): Set<string> {
  return significantWords([node.title, node.goal, ...(node.outcomes ?? [])].join(" "));
}

/**
 * Score every catalog topic by the share of its words (slug and title) that appear in the node.
 * Topics below MIN_LINK_SCORE are omitted. Sort: score desc, roadmap asc, slug asc.
 */
export function scoreTopics(node: NodeText, catalog: CatalogView): TopicCandidate[] {
  const words = nodeWords(node);
  const candidates: TopicCandidate[] = [];
  for (const roadmap of catalog.roadmaps) {
    for (const topic of roadmap.topics) {
      const topicWords = significantWords(`${topic.slug.replace(/-/g, " ")} ${topic.title}`);
      if (topicWords.size === 0) continue;
      const matched = [...topicWords].filter(word => words.has(word)).length;
      const score = matched / topicWords.size;
      if (score >= MIN_LINK_SCORE) {
        candidates.push({ roadmap: roadmap.slug, slug: topic.slug, title: topic.title, score });
      }
    }
  }
  return candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (a.roadmap < b.roadmap ? -1 : a.roadmap > b.roadmap ? 1 : 0) ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
}

/** A pick is valid when it names one of the candidates and carries a non-empty reason. */
function validPick(pick: unknown, candidates: readonly TopicCandidate[]): LinkPick | null {
  if (typeof pick !== "object" || pick === null || Array.isArray(pick)) return null;
  const { roadmap, slug, reason } = pick as { roadmap?: unknown; slug?: unknown; reason?: unknown };
  if (typeof roadmap !== "string" || typeof slug !== "string" || typeof reason !== "string") return null;
  if (!candidates.some(candidate => candidate.roadmap === roadmap && candidate.slug === slug)) return null;
  const cleanReason = reason.trim();
  if (cleanReason.length === 0) return null;
  return { roadmap, slug, reason: cleanReason };
}

/**
 * Propose the catalog topic a node covers. The deterministic proposal is the single top candidate;
 * a tie or no candidate means no proposal. With a `rerank`, the model chooses among the candidates.
 * A thrown call, a null answer or an answer outside the candidates falls back to the deterministic
 * proposal. The model never adds a topic that the word overlap did not offer.
 */
export async function linkNodeToTopic(
  node: NodeText,
  catalog: CatalogView,
  options: { rerank?: LinkRerank; topN?: number } = {},
): Promise<TopicLinkResult> {
  const candidates = scoreTopics(node, catalog).slice(0, options.topN ?? DEFAULT_LINK_TOP_N);
  const top = candidates[0];
  const tied = candidates.length > 1 && candidates[1]!.score === top?.score;

  const deterministic: TopicLinkProposal | null =
    top === undefined || tied
      ? null
      : {
          link: { roadmap: top.roadmap, slug: top.slug },
          title: top.title,
          source: "deterministic",
          reason: `highest word overlap (${Math.round(top.score * 100)}% of topic words in the node)`,
        };

  if (top === undefined || options.rerank === undefined) {
    return { proposal: deterministic, candidates, modelOutcome: "not-called" };
  }

  let answer: unknown = null;
  let threw = false;
  try {
    answer = await options.rerank(node, candidates);
  } catch {
    threw = true;
  }
  if (threw || answer === null || answer === undefined) {
    return { proposal: deterministic, candidates, modelOutcome: "failed" };
  }
  const pick = validPick(answer, candidates);
  if (pick === null) {
    return { proposal: deterministic, candidates, modelOutcome: "invalid" };
  }
  const chosen = candidates.find(candidate => candidate.roadmap === pick.roadmap && candidate.slug === pick.slug)!;
  return {
    proposal: {
      link: { roadmap: chosen.roadmap, slug: chosen.slug },
      title: chosen.title,
      source: "model",
      reason: pick.reason,
    },
    candidates,
    modelOutcome: "accepted",
  };
}

/** Catalog view with topic prerequisites, the part the prerequisite helper reads. */
export type EdgeCatalogView = {
  roadmaps: { slug: string; topics: { slug: string; prerequisites: readonly string[] }[] }[];
};

/**
 * A path node reduced to what prerequisites need: its id, its own prerequisites (absent on older
 * data) and its catalog link, if any.
 */
export type LinkedNode = { id: string; prerequisites?: readonly string[]; catalogTopic?: CatalogTopicLink };

export type NodePrerequisites = {
  nodeId: string;
  /** Node ids this node depends on, in module order. */
  prerequisiteIds: string[];
  /**
   * "node": the node's own prerequisites, as set by the Architect (an empty list is a root).
   * "catalog": linked catalog edges. "module-order": the fallback (the previous node, if any).
   */
  source: "node" | "catalog" | "module-order";
};

/**
 * Prerequisites for each node in module order. A node with its own `prerequisites` depends on
 * exactly those. Otherwise a linked node depends on the other linked nodes whose catalog topic is a
 * catalog prerequisite of its own topic. Otherwise, including every unlinked node, it depends on
 * the node before it in module order, and the first node depends on nothing.
 */
export function nodePrerequisites(nodes: readonly LinkedNode[], catalog: EdgeCatalogView): NodePrerequisites[] {
  return nodes.map((node, index) => {
    if (node.prerequisites !== undefined) {
      return { nodeId: node.id, prerequisiteIds: [...node.prerequisites], source: "node" as const };
    }
    const link = node.catalogTopic;
    const topic =
      link === undefined
        ? undefined
        : catalog.roadmaps
            .find(roadmap => roadmap.slug === link.roadmap)
            ?.topics.find(entry => entry.slug === link.slug);
    const prerequisiteSlugs = new Set(topic?.prerequisites ?? []);

    const catalogIds =
      link === undefined || prerequisiteSlugs.size === 0
        ? []
        : nodes
            .filter(
              other =>
                other.id !== node.id &&
                other.catalogTopic !== undefined &&
                other.catalogTopic.roadmap === link.roadmap &&
                prerequisiteSlugs.has(other.catalogTopic.slug),
            )
            .map(other => other.id);

    if (catalogIds.length > 0) {
      return { nodeId: node.id, prerequisiteIds: catalogIds, source: "catalog" as const };
    }
    const previous = index > 0 ? nodes[index - 1]!.id : undefined;
    return {
      nodeId: node.id,
      prerequisiteIds: previous === undefined ? [] : [previous],
      source: "module-order" as const,
    };
  });
}
