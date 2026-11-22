/** Roadmap proposals from ordinary LearnHarness sessions (0.4.0).
 *
 * The prober and the teacher find out the learner's goal and level themselves.
 * When the goal is wider than one topic they may offer a roadmap; after the
 * learner agrees they call `roadmap_propose` with the full diagnostic dossier.
 * The dossier is validated, size-capped and saved as a research note of origin
 * "diagnostic". The Architect builds from it. `applyMisconceptionsTool` (the Error
 * Ledger move) is deliberately NOT offered to the Architect (issue #19).
 *
 * Never offered in chats linked to a roadmap node, in research sessions, in a
 * chat where the learner declined, or when the setting is off.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PluginAgentTool, PluginBackendContext, PluginTools } from "learnharness-plugin-api";
import { ERROR_CATEGORIES } from "./domain.ts";
import type { ErrorCategory, LearningPath } from "./domain.ts";
import type { ResearchNotes } from "./research/notes.ts";
import { appendError, findChatLink, newErrorEntry } from "./session-links.ts";
import type { LearningPathStore } from "./store.ts";

export const VERDICTS = ["knows", "partial", "does_not_know", "misconception"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface AssessmentItem {
  readonly topic: string;
  readonly probe: string;
  readonly answer: string;
  readonly verdict: Verdict;
  readonly observations?: string;
}
export interface GapItem {
  readonly topic: string;
  readonly neededFor?: string;
}
export interface MisconceptionItem {
  readonly category: ErrorCategory;
  readonly summary: string;
  readonly example?: string;
  readonly topic?: string;
}
export interface SourceMention {
  readonly title: string;
  readonly stance: "uses" | "mentioned" | "avoid";
}
export interface Dossier {
  readonly goal: string;
  readonly motivation?: string;
  readonly background: string;
  readonly assessment: readonly AssessmentItem[];
  readonly strengths: readonly string[];
  readonly gaps: readonly GapItem[];
  readonly misconceptions: readonly MisconceptionItem[];
  readonly learningPreferences?: string;
  readonly constraints?: string;
  readonly sources: readonly SourceMention[];
  readonly openQuestions: readonly string[];
  readonly transcriptExcerpt?: string;
  /** Server-owned: the chat that produced the dossier. */
  readonly sourceChatId: string;
}

/** Field limits, in characters / items. */
export const LIMITS = {
  goal: 1500, motivation: 800, background: 3000, text: 600, long: 1500, preferences: 1500, constraints: 1500,
  transcript: 8000, assessment: 30, strengths: 30, gaps: 30, misconceptions: 20, sources: 30, openQuestions: 15,
} as const;

export class DossierError extends Error {}

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DossierError(`${field} must be an object.`);
  return value as Record<string, unknown>;
};
/** Over-long text is cut, not refused: a long but honest dossier must still go through. */
const text = (value: unknown, field: string, max: number, required = false): string | undefined => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new DossierError(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new DossierError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new DossierError(`${field} is required.`);
    return undefined;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};
const list = (value: unknown, field: string, max: number): unknown[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DossierError(`${field} must be an array.`);
  return value.slice(0, max);
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new DossierError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
};

/** Validate and cap a dossier; `sourceChatId` always comes from the server. */
export function parseDossier(raw: unknown, sourceChatId: string): Dossier {
  const value = record(raw, "dossier");
  const assessment = list(value.assessment, "assessment", LIMITS.assessment).map((entry, index) => {
    const item = record(entry, `assessment[${index}]`);
    return {
      topic: text(item.topic, `assessment[${index}].topic`, LIMITS.text, true)!,
      probe: text(item.probe, `assessment[${index}].probe`, LIMITS.long, true)!,
      answer: text(item.answer, `assessment[${index}].answer`, LIMITS.long) ?? "—",
      verdict: oneOf(item.verdict, VERDICTS, `assessment[${index}].verdict`),
      ...(text(item.observations, `assessment[${index}].observations`, LIMITS.long) ? { observations: text(item.observations, "", LIMITS.long)! } : {}),
    };
  });
  const gaps = list(value.gaps, "gaps", LIMITS.gaps).map((entry, index) => {
    if (typeof entry === "string") return { topic: text(entry, `gaps[${index}]`, LIMITS.text, true)! };
    const item = record(entry, `gaps[${index}]`);
    const neededFor = text(item.neededFor, `gaps[${index}].neededFor`, LIMITS.text);
    return { topic: text(item.topic, `gaps[${index}].topic`, LIMITS.text, true)!, ...(neededFor ? { neededFor } : {}) };
  });
  const misconceptions = list(value.misconceptions, "misconceptions", LIMITS.misconceptions).map((entry, index) => {
    const item = record(entry, `misconceptions[${index}]`);
    const example = text(item.example, `misconceptions[${index}].example`, LIMITS.long);
    const topic = text(item.topic, `misconceptions[${index}].topic`, LIMITS.text);
    return {
      category: oneOf(item.category, ERROR_CATEGORIES, `misconceptions[${index}].category`),
      summary: text(item.summary, `misconceptions[${index}].summary`, LIMITS.long, true)!,
      ...(example ? { example } : {}),
      ...(topic ? { topic } : {}),
    };
  });
  const sources = list(value.sources, "sources", LIMITS.sources).map((entry, index) => {
    if (typeof entry === "string") return { title: text(entry, `sources[${index}]`, LIMITS.text, true)!, stance: "mentioned" as const };
    const item = record(entry, `sources[${index}]`);
    return {
      title: text(item.title, `sources[${index}].title`, LIMITS.text, true)!,
      stance: item.stance === undefined ? ("mentioned" as const) : oneOf(item.stance, ["uses", "mentioned", "avoid"] as const, `sources[${index}].stance`),
    };
  });
  const strings = (field: "strengths" | "openQuestions", max: number): string[] =>
    list(value[field], field, max).map((entry, index) => text(entry, `${field}[${index}]`, LIMITS.text, true)!);
  const optional = (field: "motivation" | "learningPreferences" | "constraints" | "transcriptExcerpt", max: number) => {
    const result = text(value[field], field, max);
    return result ? { [field]: result } : {};
  };
  return {
    goal: text(value.goal, "goal", LIMITS.goal, true)!,
    ...optional("motivation", LIMITS.motivation),
    background: text(value.background, "background", LIMITS.background, true)!,
    assessment,
    strengths: strings("strengths", LIMITS.strengths),
    gaps,
    misconceptions,
    ...optional("learningPreferences", LIMITS.preferences),
    ...optional("constraints", LIMITS.constraints),
    sources,
    openQuestions: strings("openQuestions", LIMITS.openQuestions),
    ...optional("transcriptExcerpt", LIMITS.transcript),
    sourceChatId,
  } as Dossier;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  knows: "knows confidently", partial: "partially", does_not_know: "does not know", misconception: "misconception",
};

/** The note body the Architect reads: everything, as Markdown, plus the JSON. */
export function dossierMarkdown(dossier: Dossier): string {
  const lines = [`# Diagnostic dossier`, "", `**Goal:** ${dossier.goal}`];
  if (dossier.motivation) lines.push(`**Motivation:** ${dossier.motivation}`);
  lines.push(`**Background:** ${dossier.background}`, "", "## Assessment");
  for (const item of dossier.assessment) {
    lines.push(`- **${item.topic}** — ${VERDICT_LABEL[item.verdict]}. Asked: ${item.probe}. Answer: ${item.answer}.${item.observations ? ` Notes: ${item.observations}` : ""}`);
  }
  const section = (title: string, items: readonly string[]): void => {
    if (items.length) lines.push("", `## ${title}`, ...items.map((item) => `- ${item}`));
  };
  section("Strengths (skip or review briefly)", dossier.strengths);
  section("Gaps", dossier.gaps.map((gap) => `${gap.topic}${gap.neededFor ? ` (needed for ${gap.neededFor})` : ""}`));
  section("Misconceptions", dossier.misconceptions.map((item, index) => `[${index}] ${item.category}: ${item.summary}${item.example ? ` — e.g. ${item.example}` : ""}${item.topic ? ` (topic: ${item.topic})` : ""}`));
  if (dossier.learningPreferences) lines.push("", `## Learning preferences`, dossier.learningPreferences);
  if (dossier.constraints) lines.push("", `## Constraints`, dossier.constraints);
  section("Sources", dossier.sources.map((source) => `${source.title} (${source.stance})`));
  section("Open questions", dossier.openQuestions);
  if (dossier.transcriptExcerpt) lines.push("", "## Transcript excerpt", dossier.transcriptExcerpt);
  lines.push("", "## Data", "```json", JSON.stringify(dossier), "```");
  return lines.join("\n");
}

/** Read the structured dossier back from a note body. */
export function dossierFromNote(body: string): Dossier | null {
  const match = /## Data\n```json\n([\s\S]*?)\n```\s*$/.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as Dossier;
  } catch {
    return null;
  }
}

export interface ProposalSummary {
  readonly noteId: string;
  readonly goal: string;
  readonly background: string;
  readonly gaps: number;
  readonly misconceptions: number;
  readonly strengths: number;
}

/** Chats where the learner said "not now". */
export interface DeclinedChats {
  has(chatId: string): boolean;
  add(chatId: string): void;
}

export function createDeclinedChats(dataDirectory: string): DeclinedChats {
  const file = path.join(dataDirectory, "declined-proposals.json");
  const load = (): string[] => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has: (chatId) => load().includes(chatId),
    add(chatId) {
      const next = [...new Set([...load(), chatId])].slice(-500);
      fs.mkdirSync(dataDirectory, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}

export const PROPOSE_INSTRUCTIONS = [
  "Roadmap proposals (only when the tool roadmap_propose is in your current tool set; otherwise ignore this section):",
  "- Offer a learning roadmap only when you already understand the learner's goal, their current level and their main constraints, and the goal needs several topics or modules (not one topic or one question).",
  "- When: as soon as your assessment shows the goal is wider than this session. Concretely — if you present a session plan and the learner's goal takes weeks or months (an exam level, a job, a whole field), the SAME turn must end with one ask_user_question offering a roadmap for the whole goal (options like \"Yes, build a roadmap\" / \"Later\"). Do not wait for the learner to ask about the bigger picture.",
  "- Offer at most once per session, without pressure, in one short sentence. If the learner declines, do not offer again in this session.",
  "- Do not promise that this session will become part of the roadmap or be linked to it: roadmap sessions are started from the roadmap's nodes later.",
  "- Ask in the chat first. Call roadmap_propose only after the learner agrees, or when the learner asks for a roadmap themselves.",
  "- roadmap_propose takes the FULL dossier, not a summary: everything you found out — goal in their words and refined, motivation, background, every topic you assessed (what you asked, what they answered, your verdict, observations), strengths, prerequisite gaps with what depends on them, misconceptions with root-cause category and an example from the conversation, learning preferences, constraints (language, budget, hardware/software, available time — for scope only, never as a schedule), sources they use or avoid, open questions, and short verbatim key excerpts of the conversation.",
  "- Write the dossier in the language the learner writes to you (quote their words verbatim). Refer to them as \"the learner\" (or «ученик»), never with gendered pronouns.",
  "- After the tool returns, tell the learner they can press Build on the card; do not build the roadmap yourself.",
].join("\n");

const ok = <T>(details: T, message: string): AgentToolResult<T> => ({ content: [{ type: "text", text: message }], details });
const fail = (message: string): AgentToolResult<{ error: string }> => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  details: { error: message },
  isError: true,
});

const str = (description: string, maxLength: number): Record<string, unknown> => ({ type: "string", description, maxLength });
const DOSSIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "background", "assessment"],
  properties: {
    goal: str("What the learner wants to be able to DO at the end: their words, then your refined formulation.", LIMITS.goal),
    motivation: str("Why (job, exam, project, interest), if it came up.", LIMITS.motivation),
    background: str("What they already know: adjacent experience, education, tools.", LIMITS.background),
    assessment: {
      type: "array", maxItems: LIMITS.assessment, description: "Every topic you checked.",
      items: {
        type: "object", additionalProperties: false, required: ["topic", "probe", "verdict"],
        properties: {
          topic: str("Topic.", LIMITS.text),
          probe: str("What you asked or the task you gave.", LIMITS.long),
          answer: str("Their answer, briefly or verbatim when it matters.", LIMITS.long),
          verdict: { type: "string", enum: [...VERDICTS] },
          observations: str("What you noticed.", LIMITS.long),
        },
      },
    },
    strengths: { type: "array", maxItems: LIMITS.strengths, items: str("Already mastered; can be skipped or reviewed briefly.", LIMITS.text) },
    gaps: {
      type: "array", maxItems: LIMITS.gaps,
      items: { type: "object", additionalProperties: false, required: ["topic"], properties: { topic: str("Missing prerequisite.", LIMITS.text), neededFor: str("What depends on it.", LIMITS.text) } },
    },
    misconceptions: {
      type: "array", maxItems: LIMITS.misconceptions,
      items: {
        type: "object", additionalProperties: false, required: ["category", "summary"],
        properties: {
          category: { type: "string", enum: [...ERROR_CATEGORIES], description: "Cognitive root cause, as in the Error Ledger." },
          summary: str("The wrong idea or error, concretely.", LIMITS.long),
          example: str("Example from this conversation.", LIMITS.long),
          topic: str("Topic it belongs to.", LIMITS.text),
        },
      },
    },
    learningPreferences: str("How they prefer to learn, if it showed (theory/practice, video/text, through code).", LIMITS.preferences),
    constraints: str("Language of materials, budget (free only?), hardware/software, available time (for scope only).", LIMITS.constraints),
    sources: {
      type: "array", maxItems: LIMITS.sources,
      items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: str("Book, course or material.", LIMITS.text), stance: { type: "string", enum: ["uses", "mentioned", "avoid"] } } },
    },
    openQuestions: { type: "array", maxItems: LIMITS.openQuestions, items: str("What you could not find out.", LIMITS.text) },
    transcriptExcerpt: str("Key lines of the conversation, verbatim, short.", LIMITS.transcript),
  },
};

export interface ProposalOptions {
  readonly store: LearningPathStore;
  readonly notes: ResearchNotes;
  readonly declined: DeclinedChats;
  readonly isResearchChat: (chatId: string) => boolean;
  readonly enabled: () => boolean;
  readonly onProposal?: (summary: ProposalSummary, chatId: string) => void;
}

/** Whether a chat may get the tool (and therefore the offer). */
export function proposalAllowed(options: ProposalOptions, chatId: string): boolean {
  if (!options.enabled()) return false;
  if (findChatLink(options.store.paths(), chatId)) return false;
  if (options.isResearchChat(chatId)) return false;
  return !options.declined.has(chatId);
}

export function proposeTool(options: ProposalOptions, chatId: string): AgentTool {
  return {
    name: "roadmap_propose",
    label: "Propose a roadmap",
    description:
      "Hand the learner's full diagnostic dossier to the Roadmap Architect and show the learner a card to build a roadmap. " +
      "Call only after the learner agreed (or asked for a roadmap). Pass everything you found out, not a summary.",
    parameters: DOSSIER_SCHEMA as never,
    execute: async (_id, params) => {
      let dossier: Dossier;
      try {
        dossier = parseDossier(params, chatId);
      } catch (error) {
        if (error instanceof DossierError) return fail(`Dossier rejected, nothing was saved: ${error.message}`) as never;
        throw error;
      }
      const note = options.notes.add({ title: dossier.goal.slice(0, 160), origin: "diagnostic", body: dossierMarkdown(dossier), chatId });
      const summary: ProposalSummary = {
        noteId: note.id,
        goal: dossier.goal,
        background: dossier.background,
        gaps: dossier.gaps.length,
        misconceptions: dossier.misconceptions.length,
        strengths: dossier.strengths.length,
      };
      options.onProposal?.(summary, chatId);
      return ok(summary, `Dossier saved as diagnostic note ${note.id}. The learner now sees a card with "Build" and "Not now"; do not build the roadmap yourself.`) as never;
    },
  };
}

export function registerProposals(ctx: PluginBackendContext, options: ProposalOptions): { sync(): void; dispose(): void } {
  let unregister: (() => void) | null = null;
  const sync = (): void => {
    if (options.enabled() && !unregister) {
      const offInstructions = ctx.registerInstructions({ agents: ["prober", "teacher"], text: PROPOSE_INSTRUCTIONS });
      const contribution: PluginTools = {
        agents: ["prober", "teacher"],
        create: (context) => (proposalAllowed(options, context.chatId) ? [proposeTool(options, context.chatId)] : []),
      };
      const offTools = ctx.registerTools(contribution);
      unregister = () => {
        offInstructions();
        offTools();
      };
    } else if (!options.enabled() && unregister) {
      unregister();
      unregister = null;
    }
  };
  sync();
  return {
    sync,
    dispose() {
      unregister?.();
      unregister = null;
    },
  };
}

/** Architect tool: move the dossier's misconceptions into the Error Ledger. */
export function applyMisconceptionsTool(
  ctx: PluginBackendContext,
  options: { store: LearningPathStore; notes: ResearchNotes; onPathChanged?: (path: LearningPath) => void },
): PluginAgentTool {
  return {
    name: "apply_dossier_misconceptions",
    description:
      "After saving a path built from a diagnostic dossier: put each of the dossier's misconceptions into the Error Ledger of the node " +
      "that addresses it (usually the contrast or bridge node you added for it), as unresolved entries that travel into future lessons. " +
      "assignments: [{ index: misconception number from the dossier, nodeId }]. Call once; entries already moved are skipped.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["noteId", "pathId", "assignments"],
      properties: {
        noteId: { type: "string" },
        pathId: { type: "string" },
        assignments: {
          type: "array",
          maxItems: LIMITS.misconceptions,
          items: { type: "object", additionalProperties: false, required: ["index", "nodeId"], properties: { index: { type: "integer", minimum: 0 }, nodeId: { type: "string" } } },
        },
      },
    },
    execute: async (_id, params) => {
      if (ctx.signal.aborted) return fail("The plugin is shutting down.");
      const value = (params ?? {}) as { noteId?: unknown; pathId?: unknown; assignments?: unknown };
      const note = typeof value.noteId === "string" ? options.notes.read(value.noteId) : null;
      const dossier = note && note.origin === "diagnostic" ? dossierFromNote(note.body) : null;
      if (!note || !dossier) return fail("Unknown diagnostic note; use the id from the first message.");
      let path = typeof value.pathId === "string" ? options.store.path(value.pathId) : null;
      if (!path) return fail("Unknown path id; save the path first and use its id.");
      const assignments = Array.isArray(value.assignments) ? value.assignments : [];
      const moved: string[] = [];
      const problems: string[] = [];
      const now = new Date().toISOString();
      for (const raw of assignments) {
        const { index, nodeId } = (raw ?? {}) as { index?: unknown; nodeId?: unknown };
        const item = typeof index === "number" ? dossier.misconceptions[index] : undefined;
        const node = typeof nodeId === "string" ? path.modules.flatMap((module) => module.nodes).find((entry) => entry.id === nodeId) : undefined;
        if (!item) {
          problems.push(`no misconception #${String(index)}`);
          continue;
        }
        if (!node) {
          problems.push(`no node "${String(nodeId)}"`);
          continue;
        }
        const summary = `${item.summary}${item.example ? ` (e.g. ${item.example})` : ""} [diagnostic]`.slice(0, 2000);
        if (node.errors.some((entry) => entry.summary === summary)) continue;
        path = appendError(path, node.id, newErrorEntry({ id: randomUUID(), category: item.category, summary, chatId: dossier.sourceChatId, now }), now);
        moved.push(`#${String(index)} → ${node.title}`);
      }
      if (moved.length) {
        const saved = options.store.savePath(path);
        options.onPathChanged?.(saved);
      }
      return ok(
        { moved: moved.length, problems },
        `${moved.length ? `Moved to the Error Ledger: ${moved.join("; ")}.` : "Nothing new to move."}${problems.length ? ` Skipped: ${problems.join("; ")}.` : ""}`,
      );
    },
  };
}

/** The first message of a roadmap built from a dossier. */
export function buildMessage(noteId: string, locale: string): string {
  return locale === "ru"
    ? `Построй дорожную карту по досье из диагностики ${noteId}.`
    : `Build a roadmap from diagnostic dossier ${noteId}.`;
}
