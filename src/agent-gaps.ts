// Read-only gap and next-node views for the teaching agent (issue #11), ported from the roadmap
// plugin's roadmap_gaps tool. Pure: no I/O, no model call, no clock. Nothing is registered with the
// host here; tool registration is deferred. A failed read returns { isError: true, error }, never a
// partial or fabricated list.
import { validateLearningPath, type LearningPath, type PathNode } from "./domain.ts";
import type { Mastery, MasteryLevel } from "./learner-map.ts";
import { nodePrerequisites, type EdgeCatalogView, type NodePrerequisites } from "./node-catalog-link.ts";
import { findNodeGaps, type NodeGap } from "./node-gaps.ts";
import { rankNextNodes, type NextReason } from "./node-next.ts";

/** The input both tools read: a roadmap, the learner's mastery, and an optional catalog for edges. */
export type AgentGapsInput = {
  /** A learning path as stored (validated on read). */
  path: unknown;
  /** Knowledge Graph mastery, as deriveMastery() returns it. */
  mastery: unknown;
  /** Optional roadmap.sh catalog with topic prerequisites. Without it, order follows the modules. */
  catalog?: unknown;
};

export type AgentReadError = { isError: true; error: string };

export type NodeGapEntry = {
  nodeId: string;
  kind: "missing" | "weak_prereq";
  severity: number;
  /** Unseen prerequisite nodes that block this node. Empty for "missing" gaps. */
  blockers: string[];
};

export type NodeGapsResult = { isError: false; roadmap: string; gaps: NodeGapEntry[] } | AgentReadError;

export type NextNodeEntry = { id: string; title: string; reasons: NextReason[] };

export type NextNodeResult = { isError: false; roadmap: string; next: NextNodeEntry | null } | AgentReadError;

const MASTERY_LEVELS: readonly MasteryLevel[] = ["seen", "practiced", "mastered"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function arrayOf(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function stringOf(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function readMastery(value: unknown): Mastery[] {
  return arrayOf(value, "mastery").map((entry, index) => {
    const path = `mastery[${index}]`;
    const record = objectOf(entry, path);
    const level = record.level;
    if (typeof level !== "string" || !MASTERY_LEVELS.includes(level as MasteryLevel)) {
      throw new Error(`${path}.level must be one of ${MASTERY_LEVELS.join(", ")}`);
    }
    const evidence = arrayOf(record.evidence, `${path}.evidence`).map((item, itemIndex) => {
      const point = objectOf(item, `${path}.evidence[${itemIndex}]`);
      return {
        sessionId: stringOf(point.sessionId, `${path}.evidence[${itemIndex}].sessionId`),
        at: stringOf(point.at, `${path}.evidence[${itemIndex}].at`),
      };
    });
    return {
      topicId: stringOf(record.topicId, `${path}.topicId`),
      level: level as MasteryLevel,
      evidence,
    };
  });
}

function readCatalog(value: unknown): EdgeCatalogView {
  const record = objectOf(value, "catalog");
  const roadmaps = arrayOf(record.roadmaps, "catalog.roadmaps").map((entry, index) => {
    const path = `catalog.roadmaps[${index}]`;
    const roadmap = objectOf(entry, path);
    const topics = arrayOf(roadmap.topics, `${path}.topics`).map((topic, topicIndex) => {
      const topicPath = `${path}.topics[${topicIndex}]`;
      const item = objectOf(topic, topicPath);
      const prerequisites = arrayOf(item.prerequisites ?? [], `${topicPath}.prerequisites`).map(prerequisite =>
        stringOf(prerequisite, `${topicPath}.prerequisites[]`),
      );
      return { slug: stringOf(item.slug, `${topicPath}.slug`), prerequisites };
    });
    return { slug: stringOf(roadmap.slug, `${path}.slug`), topics };
  });
  return { roadmaps };
}

/**
 * Validates the input and computes the gaps for the roadmap. Throws on any malformed input or data
 * error (including a prerequisite cycle); the public functions turn the throw into isError.
 */
type Analysis = { roadmap: string; nodes: PathNode[]; prerequisites: NodePrerequisites[]; gaps: NodeGap[] };

/**
 * The id of a roadmap with no nodes, or undefined. The domain schema refuses to store a module with
 * no nodes, so an empty roadmap is read here structurally: it needs a string id and a modules array,
 * and every module must have an empty node list.
 */
function emptyRoadmapId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (!Array.isArray(value.modules)) return undefined;
  const empty = value.modules.every(module => isRecord(module) && Array.isArray(module.nodes) && module.nodes.length === 0);
  return empty ? value.id : undefined;
}

/**
 * Validates the input and computes the gaps for the roadmap. Throws on any malformed input or data
 * error (including a prerequisite cycle); the public functions turn the throw into isError.
 */
function analyse(input: unknown): Analysis {
  const record = objectOf(input, "input");
  const mastery = readMastery(record.mastery);
  const catalog: EdgeCatalogView = record.catalog === undefined ? { roadmaps: [] } : readCatalog(record.catalog);

  const emptyId = emptyRoadmapId(record.path);
  if (emptyId !== undefined) return { roadmap: emptyId, nodes: [], prerequisites: [], gaps: [] };

  const validated = validateLearningPath(record.path);
  if (!validated.ok) {
    const issues = validated.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid roadmap: ${issues}`);
  }
  const path: LearningPath = validated.value;
  const nodes = path.modules.flatMap(module => module.nodes);
  const prerequisites = nodePrerequisites(nodes, catalog);
  const gaps = findNodeGaps({ roadmap: path.id, nodes, prerequisites, mastery });
  return { roadmap: path.id, nodes: [...nodes], prerequisites, gaps };
}

function failure(error: unknown): AgentReadError {
  return { isError: true, error: error instanceof Error ? error.message : String(error) };
}

/** The gaps of a roadmap, most severe first. An empty roadmap has none. */
export function readNodeGaps(input: AgentGapsInput | unknown): NodeGapsResult {
  try {
    const { roadmap, gaps } = analyse(input);
    return {
      isError: false,
      roadmap,
      gaps: gaps.map((gap: NodeGap) => ({
        nodeId: gap.nodeId,
        kind: gap.kind,
        severity: gap.severity,
        blockers: gap.blockedBy ?? [],
      })),
    };
  } catch (error) {
    return failure(error);
  }
}

/** The top recommended next node of a roadmap, or null when no node is ready. */
export function readNextNode(input: AgentGapsInput | unknown): NextNodeResult {
  try {
    const { roadmap, nodes, prerequisites, gaps } = analyse(input);
    const [top] = rankNextNodes({ nodes, prerequisites, gaps, limit: 1 });
    if (top === undefined) return { isError: false, roadmap, next: null };
    const node = nodes.find(entry => entry.id === top.nodeId);
    if (node === undefined) throw new Error(`Next node "${top.nodeId}" is not in the roadmap`);
    return {
      isError: false,
      roadmap,
      next: { id: node.id, title: node.title, reasons: top.reasons },
    };
  } catch (error) {
    return failure(error);
  }
}
