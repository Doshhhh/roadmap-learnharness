import type { GraphNode, GraphSnapshot } from "learnharness-plugin-api";

/** Version of the mastery rules below. Bump when the rules change so stored results can be told apart. */
export const LEARNER_MAP_RULES_VERSION = 1;
/** Distinct sessions with practice evidence needed for "mastered". */
export const MASTERED_SESSION_THRESHOLD = 3;

export type MasteryLevel = "seen" | "practiced" | "mastered";
export type MasteryEvidence = { sessionId: string; at: string };
export type Mastery = { topicId: string; level: MasteryLevel; evidence: MasteryEvidence[] };

/** The only part of the graph snapshot the learner map reads. */
export type LearnerGraph = Pick<GraphSnapshot, "propositions" | "chains">;

/** Lowercase hyphen slug. "C++" → "c-plus-plus", "C#" → "c-sharp", accents removed. */
export function topicKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/#/g, " sharp ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function keysFor(node: GraphNode): string[] {
  const keys = new Set([node.name, ...node.aliases].map(topicKey).filter(Boolean));
  return [...keys];
}

/** Keep the earliest timestamp seen for each session. */
function note(map: Map<string, string>, sessionId: string, at: string): void {
  const previous = map.get(sessionId);
  if (previous === undefined || at < previous) map.set(sessionId, at);
}

/**
 * Derive per-topic mastery from a graph snapshot. Pure: no I/O.
 *
 * Rules (Q2 defaults, versioned by LEARNER_MAP_RULES_VERSION):
 * - seen: a stored proposition for the topic appears in at least one session.
 * - practiced: the topic is a premise or conclusion of a reasoning chain in at least one session.
 * - mastered: practiced in at least MASTERED_SESSION_THRESHOLD distinct sessions.
 *
 * Topics with no evidence are omitted; the gap engine treats them as unseen.
 */
export function deriveMastery(graph: LearnerGraph): Mastery[] {
  const nodeById = new Map<string, GraphNode>();
  const seen = new Map<string, Map<string, string>>();
  const practiced = new Map<string, Map<string, string>>();
  const bucket = (table: Map<string, Map<string, string>>, key: string) => {
    let entry = table.get(key);
    if (!entry) table.set(key, (entry = new Map()));
    return entry;
  };

  for (const node of graph.propositions) {
    nodeById.set(node.id, node);
    for (const key of keysFor(node)) {
      for (const point of node.provenance) note(bucket(seen, key), point.chatId, node.createdAt);
    }
  }

  for (const chain of graph.chains) {
    for (const id of [...chain.premises, chain.conclusion]) {
      const node = nodeById.get(id);
      if (!node) continue;
      for (const key of keysFor(node)) {
        for (const point of chain.provenance) note(bucket(practiced, key), point.chatId, chain.createdAt);
      }
    }
  }

  const topics = new Set([...seen.keys(), ...practiced.keys()]);
  const result: Mastery[] = [];
  for (const topicId of [...topics].sort()) {
    const seenSessions = seen.get(topicId) ?? new Map<string, string>();
    const practiceSessions = practiced.get(topicId) ?? new Map<string, string>();
    const merged = new Map(seenSessions);
    for (const [sessionId, at] of practiceSessions) note(merged, sessionId, at);
    if (merged.size === 0) continue;

    const level: MasteryLevel =
      practiceSessions.size >= MASTERED_SESSION_THRESHOLD ? "mastered" : practiceSessions.size > 0 ? "practiced" : "seen";
    const evidence = [...merged]
      .map(([sessionId, at]) => ({ sessionId, at }))
      .sort((a, b) => a.at.localeCompare(b.at) || a.sessionId.localeCompare(b.sessionId));
    result.push({ topicId, level, evidence });
  }
  return result;
}

/** Read the graph once and derive mastery from that single snapshot (read-only). */
export function readLearnerMap(learning: { graph(): LearnerGraph }): Mastery[] {
  return deriveMastery(learning.graph());
}
