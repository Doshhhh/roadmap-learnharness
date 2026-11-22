import type { GraphNode, GraphSnapshot } from "learnharness-plugin-api";

/** Most topics (stored propositions) a brief carries. Extra topics are counted, not listed. */
export const BRIEF_MAX_TOPICS = 60;
/** Most reasoning chains a brief carries. Extra chains are counted, not listed. */
export const BRIEF_MAX_CHAINS = 60;
/** Longest statement kept per topic, in characters (the cut ends with an ellipsis). */
export const BRIEF_MAX_STATEMENT_CHARS = 280;
/** Longest topic name kept, in characters. */
export const BRIEF_MAX_NAME_CHARS = 80;
/** Most aliases kept per topic. */
export const BRIEF_MAX_ALIASES = 5;
/** Longest alias kept, in characters. */
export const BRIEF_MAX_ALIAS_CHARS = 120;

export interface GraphBriefTopic {
  name: string;
  statement: string;
  aliases: string[];
  /** Distinct chat ids the topic came from, sorted. */
  sourceChatIds: string[];
}

export interface GraphBriefChain {
  /** Premise topic names, sorted. */
  premises: string[];
  conclusion: string;
}

export interface GraphBriefCounts {
  /** Stored topics in the graph. */
  topics: number;
  /** Stored chains whose premises and conclusion are all topics in the graph. */
  chains: number;
  /** Topics left out of the brief by BRIEF_MAX_TOPICS. */
  droppedTopics: number;
  /** Chains left out of the brief by BRIEF_MAX_CHAINS. */
  droppedChains: number;
}

export interface GraphBrief {
  topics: GraphBriefTopic[];
  chains: GraphBriefChain[];
  counts: GraphBriefCounts;
}

/** The only part of the graph snapshot the brief reads. */
export type BriefGraph = Pick<GraphSnapshot, "propositions" | "chains">;

/** Collapse whitespace and cut to `max` characters, ending with an ellipsis when cut. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Stable order: createdAt, then id. Plain string comparison, never locale-dependent. */
function byCreatedThenId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function topicFrom(node: GraphNode): GraphBriefTopic {
  return {
    name: clip(node.name, BRIEF_MAX_NAME_CHARS),
    statement: clip(node.statement, BRIEF_MAX_STATEMENT_CHARS),
    aliases: uniqueSorted(node.aliases.map(alias => clip(alias, BRIEF_MAX_ALIAS_CHARS)).filter(Boolean)).slice(
      0,
      BRIEF_MAX_ALIASES,
    ),
    sourceChatIds: uniqueSorted(node.provenance.map(point => point.chatId).filter(Boolean)),
  };
}

/**
 * Compact, deterministic brief of what the learner has already taken in.
 * Pure and read-only: no I/O, no model calls, no clock reads. The same graph
 * gives the same brief regardless of the order of the input arrays.
 * An empty graph returns empty lists and zero counts.
 */
export function buildGraphBrief(graph: BriefGraph): GraphBrief {
  const topicNodes = [...graph.propositions].sort(byCreatedThenId);
  const nameById = new Map<string, string>();
  for (const node of topicNodes) {
    if (!nameById.has(node.id)) nameById.set(node.id, clip(node.name, BRIEF_MAX_NAME_CHARS));
  }

  const chainViews: GraphBriefChain[] = [];
  for (const chain of [...graph.chains].sort(byCreatedThenId)) {
    const conclusion = nameById.get(chain.conclusion);
    const premiseIds = uniqueSorted(chain.premises);
    if (conclusion === undefined || premiseIds.length === 0) continue;
    const premises: string[] = [];
    for (const id of premiseIds) {
      const name = nameById.get(id);
      if (name === undefined) break;
      premises.push(name);
    }
    if (premises.length !== premiseIds.length) continue;
    chainViews.push({ premises: uniqueSorted(premises), conclusion });
  }

  return {
    topics: topicNodes.slice(0, BRIEF_MAX_TOPICS).map(topicFrom),
    chains: chainViews.slice(0, BRIEF_MAX_CHAINS),
    counts: {
      topics: topicNodes.length,
      chains: chainViews.length,
      droppedTopics: Math.max(0, topicNodes.length - BRIEF_MAX_TOPICS),
      droppedChains: Math.max(0, chainViews.length - BRIEF_MAX_CHAINS),
    },
  };
}
