// "Studied elsewhere" evidence for one roadmap node (issue #8). Pure: no I/O, no status writes.
// The node's catalog topic link (issue #6) is matched against the Knowledge Graph mastery (issue #3).
// The result only suggests a status; the learner decides in the node panel.
import type { PathNode } from "./domain.ts";
import type { Mastery, MasteryLevel } from "./learner-map.ts";

/** The status the panel offers for the learner to confirm. Nothing is changed here. */
export type EvidenceSuggestion = "consolidated" | "skipped";

export type NodeEvidence = {
  topicId: string;
  level: MasteryLevel;
  /** Distinct sessions with evidence for the topic, of any level. */
  sessionCount: number;
  /** Earliest and latest evidence timestamps (ISO strings). */
  firstAt: string;
  lastAt: string;
  /** Set only when the level is practiced or mastered. Practiced suggests "consolidated"; mastered suggests "skipped". */
  suggestion?: EvidenceSuggestion;
};

/**
 * The evidence for a node's topic, or null when the node has no catalog link or the link matches
 * no mastery topic. The link's topic slug is matched to the mastery topicId.
 */
export function nodeEvidence(node: Pick<PathNode, "catalogTopic">, mastery: readonly Mastery[]): NodeEvidence | null {
  const link = node.catalogTopic;
  if (link === undefined) return null;
  const match = mastery.find((entry) => entry.topicId === link.slug);
  if (match === undefined || match.evidence.length === 0) return null;

  const dates = match.evidence.map((entry) => entry.at).sort();
  const evidence: NodeEvidence = {
    topicId: match.topicId,
    level: match.level,
    sessionCount: match.evidence.length,
    firstAt: dates[0]!,
    lastAt: dates[dates.length - 1]!,
  };
  if (match.level === "mastered") evidence.suggestion = "skipped";
  else if (match.level === "practiced") evidence.suggestion = "consolidated";
  return evidence;
}
