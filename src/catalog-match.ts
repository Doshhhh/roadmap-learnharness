// Match the learner's mastery (learner-map.ts) to the closest roadmap.sh catalog roadmap.
// Pure: no I/O, no model client. The model pass is an injected `rerank` function; this module
// validates its answer and falls back to the deterministic top candidate on any failure.
import type { Mastery } from "./learner-map.ts";

/** The part of a catalog this module reads. Any real Catalog is assignable to it. */
export type CatalogView = {
  roadmaps: { slug: string; title: string; topics: { slug: string; title: string }[] }[];
};

/** A catalog roadmap that the learner has at least one mastery entry for. */
export type RoadmapMatch = {
  roadmap: string;
  title: string;
  /** Catalog topics of this roadmap that the learner has any mastery for. */
  seen: number;
  /** Catalog topics of this roadmap. */
  total: number;
  /** seen / total, or 0 when the roadmap has no topics. */
  overlap: number;
  /** Matched catalog topic slugs, sorted. */
  matchedTopics: string[];
};

/** The model's answer: one candidate slug and a short reason. */
export type RerankPick = { roadmap: string; reason: string };

/**
 * Injected model pass. Receives the top candidates and resolves to the model's pick, or null when it
 * gave no answer. A rejected promise is a failed call.
 */
export type Rerank = (candidates: RoadmapMatch[]) => Promise<RerankPick | null>;

/**
 * What the model pass did. "accepted": a valid pick was used. "cached": a valid pick from the cache
 * was used. "invalid": an answer arrived but was not a valid candidate. "failed": no answer (thrown
 * call or null). "not-called": no model pass ran (no rerank given, or no candidates).
 */
export type ModelOutcome = "not-called" | "accepted" | "cached" | "invalid" | "failed";

export type CatalogMatch = {
  /** The chosen roadmap, or null when no learner topic matches the catalog. */
  selected: RoadmapMatch | null;
  /** "model" when a validated model pick was used, "deterministic" for the top candidate, "none" when nothing matched. */
  source: "model" | "deterministic" | "none";
  reason: string;
  /** The top N deterministic candidates, best first. */
  candidates: RoadmapMatch[];
  /** Catalog topic slugs of the selected roadmap that the learner has mastery for. */
  matchedTopics: string[];
  /** Catalog topics of the selected roadmap that the learner has not covered yet, in catalog order. */
  frontier: { slug: string; title: string }[];
  modelOutcome: ModelOutcome;
};

export const DEFAULT_TOP_N = 5;

export type MatchOptions = {
  mastery: Mastery[];
  catalog: CatalogView;
  rerank?: Rerank;
  /**
   * Optional cache of accepted picks, keyed by the candidate set. The caller owns it and may keep it
   * across calls. Only accepted picks are stored; failures and invalid answers are never cached.
   */
  cache?: Map<string, RerankPick>;
  /** How many deterministic candidates the model may choose from. */
  topN?: number;
};

/** Cache key for a candidate set: the sorted roadmap slugs. */
export function candidateKey(candidates: readonly RoadmapMatch[]): string {
  return candidates.map(candidate => candidate.roadmap).sort().join(",");
}

/**
 * Score every catalog roadmap by how many of its topic slugs the learner has mastery for.
 * Matching is by slug equality (learner topicId === catalog topic slug). Roadmaps with no matched
 * topic are omitted. Sort: overlap desc, seen desc, roadmap slug asc.
 */
export function rankRoadmaps(mastery: Mastery[], catalog: CatalogView): RoadmapMatch[] {
  const learnerTopics = new Set(mastery.map(entry => entry.topicId));
  const matches: RoadmapMatch[] = [];
  for (const roadmap of catalog.roadmaps) {
    const matchedTopics = roadmap.topics
      .map(topic => topic.slug)
      .filter(slug => learnerTopics.has(slug))
      .sort();
    if (matchedTopics.length === 0) continue;
    const seen = matchedTopics.length;
    const total = roadmap.topics.length;
    matches.push({
      roadmap: roadmap.slug,
      title: roadmap.title,
      seen,
      total,
      overlap: total === 0 ? 0 : seen / total,
      matchedTopics,
    });
  }
  return matches.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      b.seen - a.seen ||
      (a.roadmap < b.roadmap ? -1 : a.roadmap > b.roadmap ? 1 : 0),
  );
}

/** A pick is valid when it names one of the candidates and carries a non-empty reason. */
function validPick(pick: unknown, candidates: readonly RoadmapMatch[]): RerankPick | null {
  if (typeof pick !== "object" || pick === null || Array.isArray(pick)) return null;
  const { roadmap, reason } = pick as { roadmap?: unknown; reason?: unknown };
  if (typeof roadmap !== "string" || typeof reason !== "string") return null;
  if (!candidates.some(candidate => candidate.roadmap === roadmap)) return null;
  const cleanReason = reason.trim();
  if (cleanReason.length === 0) return null;
  return { roadmap, reason: cleanReason };
}

/**
 * Match the learner's mastery to the closest catalog roadmap. Never throws from the model pass:
 * a thrown or null answer is "failed", a bad answer is "invalid", and both fall back to the
 * deterministic top candidate. Only accepted picks are cached.
 */
export async function matchCatalog(options: MatchOptions): Promise<CatalogMatch> {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const ranked = rankRoadmaps(options.mastery, options.catalog);
  const candidates = ranked.slice(0, topN);
  const top = candidates[0];

  if (top === undefined) {
    return {
      selected: null,
      source: "none",
      reason: "no learner topics match any roadmap",
      candidates: [],
      matchedTopics: [],
      frontier: [],
      modelOutcome: "not-called",
    };
  }

  const deterministicReason = `highest topic overlap (${top.seen}/${top.total})`;
  let selected: RoadmapMatch = top;
  let source: CatalogMatch["source"] = "deterministic";
  let reason = deterministicReason;
  let modelOutcome: ModelOutcome = "not-called";

  if (options.rerank !== undefined) {
    const key = candidateKey(candidates);
    const cached = options.cache?.get(key);
    let pick: RerankPick | null = null;

    const cachedPick = cached === undefined ? null : validPick(cached, candidates);
    if (cachedPick !== null) {
      pick = cachedPick;
      modelOutcome = "cached";
    } else {
      let answer: unknown = null;
      let threw = false;
      try {
        answer = await options.rerank(candidates);
      } catch {
        threw = true;
      }
      if (threw || answer === null || answer === undefined) {
        modelOutcome = "failed";
      } else {
        pick = validPick(answer, candidates);
        if (pick === null) {
          modelOutcome = "invalid";
        } else {
          modelOutcome = "accepted";
          options.cache?.set(key, pick);
        }
      }
    }

    if (pick !== null) {
      const match = candidates.find(candidate => candidate.roadmap === pick.roadmap);
      if (match !== undefined) {
        selected = match;
        source = "model";
        reason = pick.reason;
      }
    } else if (modelOutcome === "invalid") {
      reason = `${deterministicReason}; model answer was not a candidate and was ignored`;
    } else if (modelOutcome === "failed") {
      reason = `${deterministicReason}; model call failed`;
    }
  }

  const learnerTopics = new Set(options.mastery.map(entry => entry.topicId));
  const catalogRoadmap = options.catalog.roadmaps.find(roadmap => roadmap.slug === selected.roadmap);
  const frontier = (catalogRoadmap?.topics ?? [])
    .filter(topic => !learnerTopics.has(topic.slug))
    .map(topic => ({ slug: topic.slug, title: topic.title }));

  return {
    selected,
    source,
    reason,
    candidates,
    matchedTopics: selected.matchedTopics,
    frontier,
    modelOutcome,
  };
}
