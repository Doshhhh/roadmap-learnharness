/** Question-pattern hints for the node panel (issue #35).
 *
 * Pure mapping from a node type and a session kind to an i18n key for a one-line
 * suggestion. The roadmap never selects a template: the hint only names the kind of
 * template that tends to fit. Question Patterns owns the actual format.
 */
import type { ChildSessionKind, NodeType } from "./domain.ts";
import type { MessageKey } from "./i18n.ts";

export type PatternHintKey = Extract<MessageKey, `pattern.hint.${string}`>;

const HINTS: Record<NodeType, Partial<Record<ChildSessionKind, PatternHintKey>>> = {
  holistic: { teaching: "pattern.hint.overview", practice: "pattern.hint.scenario" },
  concept: { teaching: "pattern.hint.explainBack", practice: "pattern.hint.recall" },
  contrast: { teaching: "pattern.hint.compare", practice: "pattern.hint.compare" },
  skill: { practice: "pattern.hint.worked" },
  checkpoint: { practice: "pattern.hint.selfTest" },
  bridge: { teaching: "pattern.hint.bridge" },
};

/** The hint for one node type and session kind, or null when no template is suggested. */
export function patternHintKey(type: NodeType, kind: ChildSessionKind): PatternHintKey | null {
  return HINTS[type][kind] ?? null;
}

/** The single hint line the node panel shows: practice first, then lesson. */
export function nodePatternHintKey(type: NodeType): PatternHintKey | null {
  return patternHintKey(type, "practice") ?? patternHintKey(type, "teaching");
}
