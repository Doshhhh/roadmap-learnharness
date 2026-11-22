/** Learning Path — pedagogical prompt builders.
 *
 * Two composers, both derived from FRAMEWORK.md and free of any pacing
 * language by design (FRAMEWORK.md principle 7):
 * - `buildArchitectSystemPrompt` drives the Path Architect that designs paths.
 * - `buildChildSessionBrief` seeds a linked teaching/practice session with the
 *   node's anchor, priming hook, interleaving callbacks, watchpoints and artifact.
 */
import {
  ARTIFACT_CATALOG,
  DomainValidationError,
  NODE_TYPES,
  artifactCatalogEntry,
  defaultArtifactFor,
  formatSourceAnchor,
} from "./domain.ts";
import { UPSTREAM_REPOSITORY } from "./upstream-roadmaps.ts";
import type {
  ArtifactConfig,
  ChildSessionKind,
  ErrorEntry,
  LearningPath,
  NodeType,
  PathNode,
  PluginSettings,
  SourceSpine,
} from "./domain.ts";

export interface NodeTypeGuide {
  readonly type: NodeType;
  readonly label: string;
  readonly guidance: string;
}

export const NODE_TYPE_GUIDE: readonly NodeTypeGuide[] = [
  {
    type: "holistic",
    label: "Holistic",
    guidance:
      "Structural map: system-level links between ideas; why the domain decomposes this way and how the pieces flow.",
  },
  {
    type: "concept",
    label: "Isolated concept",
    guidance:
      "One load-bearing principle, theorem, model or mechanism, made obviously true from first principles before it is combined with other parts.",
  },
  {
    type: "contrast",
    label: "Contrast",
    guidance:
      "Boundary discrimination between confusable ideas or approaches: the exact conditions that separate them, and non-examples that expose the boundary.",
  },
  {
    type: "skill",
    label: "Skill",
    guidance:
      "Brief procedural fluency: idioms, heuristics, notation moves and mechanical shortcuts that free working memory.",
  },
  {
    type: "checkpoint",
    label: "Integrative checkpoint",
    guidance:
      "Multi-topic synthesis with unlabelled problems: the learner selects the tools without a heading naming them.",
  },
  {
    type: "bridge",
    label: "Bridge",
    guidance:
      "Surgical, bounded repair of one missing upstream prerequisite; return to the main spine once that gap is closed.",
  },
];

const nodeGuide = (type: NodeType): NodeTypeGuide => {
  const guide = NODE_TYPE_GUIDE.find((candidate) => candidate.type === type);
  if (!guide) throw new Error(`Unknown node type: ${String(type)}`);
  return guide;
};

/** Type-specific loose micro-priming hook for a child session. Never a gate. */
export function microPrimingHookFor(type: NodeType): string {
  switch (type) {
    case "holistic":
      return "Default way in, when no question format is set: before naming definitions, invite the learner to predict how the main pieces of this module might connect, then compare their sketch with the structure you build.";
    case "concept":
      return "Default way in, when no question format is set: open with one concrete phenomenon or tiny case where the naive account visibly breaks, and invite an intuition before any formal definition.";
    case "contrast":
      return "Default way in, when no question format is set: present two near-identical scenarios that differ only at the boundary, and invite the learner to say which principle applies before naming either one.";
    case "skill":
      return "Default way in, when no question format is set: show a worked miniature and invite the learner to predict the next mechanical step before executing it.";
    case "checkpoint":
      return "Default way in, when no question format is set: present one unlabelled mixed problem and invite the learner to choose a strategy before solving it.";
    case "bridge":
      return "Default way in, when no question format is set: recall the exact upstream step that is missing, invite the learner to reconstruct it in one line, then repair only that step.";
  }
}

/** "OSTEP (textbook)" / "uploaded: linear-algebra-notes.md" — the spine in one line. */
export function formatSourceSpine(spine: SourceSpine): string {
  if (spine.mode === "canonical") {
    return spine.references.map((reference) => `${reference.title} (${reference.kind})`).join("; ");
  }
  return spine.sources.map((source) => `${source.name} (uploaded source ${source.sourceId})`).join("; ");
}

const artifactCatalogLines = (): string =>
  ARTIFACT_CATALOG.map(
    (entry) =>
      `- ${entry.label} (${entry.type}) — best for: ${entry.bestFor.join(", ")}. ` +
      `Justification: ${entry.justification}`,
  ).join("\n");

const settingsLines = (settings: PluginSettings | null): string => {
  const entries = Object.entries(settings?.artifactDefaults ?? {});
  if (entries.length === 0) return "No plugin-wide artifact defaults are configured; the catalog recommendation applies.";
  return `Plugin-wide artifact defaults: ${entries
    .map(([type, artifact]) => `${type} → ${artifact}`)
    .join(", ")}. A node override always wins.`;
};

const refinementLines = (path: LearningPath): string => {
  const nodes = path.modules.flatMap((module) => module.nodes);
  const present = NODE_TYPES.filter((type) => nodes.some((node) => node.type === type));
  return [
    "## Refinement mode",
    `Refining "${path.title}" (id ${path.id}).`,
    `Learner's goal: ${path.goal}`,
    `Current shape: ${path.modules.length} module(s), ${nodes.length} node(s), node types present: ${
      present.length === 0 ? "none yet" : present.join(", ")
    }.`,
    "Call get_learning_path for current ids before saving. Keep existing ids, titles and source anchors stable unless the learner asks for a change or the source demands a correction.",
    "Refinement is additive and explicit: never silently reorder, delete or rename existing nodes.",
  ].join("\n");
};

export interface ArchitectPromptOptions {
  /** Include refinement instructions and a summary of the path being edited. */
  readonly existingPath?: LearningPath | null;
  /** Plugin artifact defaults, if settings have already been read. */
  readonly settings?: PluginSettings | null;
  /** Names of the research tools this Architect has (empty: offline). */
  readonly researchTools?: readonly string[];
  /** Upstream mode (#19): sources are the learner's graph and the developer-roadmap topic files only. */
  readonly upstream?: boolean;
}

/** Roadmap-author method (approved by the owner, 2026-11-17). Sources: Matt Warden's
 * learning-plan-creator (sequencing, verification, gaps), the roadmap.sh contribution
 * rules (one-paragraph nodes, typed resources, relevance over size) and
 * learn-anything-roadmap (skip list). */
const AUTHOR_METHOD = [
  "## Roadmap author method",
  "The learner cannot judge sequencing yet. You know the dependency graph; a wrong order is worse than one good book.",
  "1. Interview: 2–3 questions per message, only what you cannot infer: the ability wanted at the end, current level and adjacent skills, constraints (language, budget, tools). Skip it when the message already answers.",
  "2. Research first (see Research): the field's canonical resources, plus deeper strong ones.",
  "3. Dependency graph: for each topic, ask what must come first. Introduce terms before use. Prefer solid foundations over a fast, brittle start.",
  "4. Route to the goal: the path reaches the stated goal. Before saving, check that every ability in the goal is taught by a node and the last module produces the goal (final project, real task, exam-level set).",
  "5. Node: one concrete ability; goal as one clear paragraph a beginner understands; 2–4 outcomes; 3–8 resources, canonical first, then deeper (lecture notes, courses, papers, niche books, other languages). `use` names the parts that serve the node and what to skip. Mark must-know resources essential: true.",
  "6. Books: name the field's most recommended books even if you cannot read them; add lesser-known strong ones for depth. Never list a resource just because it is popular; say why it is here.",
  "7. Skip list: name what the learner can safely skip for this goal (rabbit holes, outdated tools) in the path goal or a final optional node.",
  "8. Trace before saving: walk node by node. Does each node rest on what earlier nodes gave? Any unexplained term or uncovered gap? Fix the order, or state in the node goal the gap and how to close it.",
].join("\n");

const DOSSIER_LINES = [
  "## Building from a diagnostic dossier",
  "If the message names a diagnostic dossier (research note, origin \"diagnostic\"), read it fully with read_research_note first.",
  "- Do not ask again for anything the dossier already answers (goal, level, background, preferences, constraints). Skip the interview for those.",
  "- Strengths: mark mastered material optional: true, or make one short review node. Do not teach it from scratch.",
  "- Gaps: bridge nodes for every prerequisite gap, before the nodes that depend on it.",
  "- Misconceptions: a contrast node for each misconception (a bridge node when its category is prerequisite_gap), where the wrong idea would be reinforced.",
  "- Open questions: ask all in ONE message only if the answers change the path; otherwise build and state your assumption.",
  "- Constraints such as available time only scale depth and size; never turn them into dates or pacing.",
  "- Do not link the dossier's source chat to the path; sessions link only when launched from a node.",
].join("\n");

/** Issue #41: roadmap structure only from the two upstream tools; no repo path from memory in any research question. */
const REPO_RULE =
  "Roadmap structure comes only from list_roadmap_topics and read_roadmap_topic. Never write a repo URL or path from memory. " +
  "A research question may name a repo only if a tool result in this conversation gave that name.";
/** Outside upstream mode the source is named here, since the Sources section does not name it. */
const UPSTREAM_SOURCE_RULE = `- Upstream source: ${UPSTREAM_REPOSITORY}, the only one. ${REPO_RULE}`;

/** Upstream mode (#19): the only sources are the learner's graph and the roadmap.sh topic files. */
const UPSTREAM_SOURCE_LINES = [
  "## Sources (upstream mode)",
  `Order: the learner's Knowledge Graph, then the topic files of ${UPSTREAM_REPOSITORY} (roadmap.sh), the only upstream source. Books and web come second, only to enrich nodes that already exist.`,
  "- Call read_learner_graph first: it is what the learner already knows. Place those topics as optional review nodes, as the graph brief describes.",
  "- Call list_roadmap_topics with a roadmap slug, then read_roadmap_topic for each topic you use. Use only the slugs these tools return.",
  `- ${REPO_RULE}`,
  "- Books and web never create topics, nodes or roadmap structure. If GitHub cannot be reached, say so plainly and stop; never substitute another source for the structure.",
  "- A node's resources are the tagged resources of its topic file, copied exactly: the same link text and URL as written, tag included. Do not reword, shorten or invent links, and take each url only from a topic you read in this conversation.",
  `- Name roadmap.sh as the source: the sourceSpine is mode "canonical" with the reference title "roadmap.sh developer roadmap (${UPSTREAM_REPOSITORY})" and kind "course". Use the topic title as sourceAnchor reference.`,
  "- Do not add a resource that the topic files do not list. A node with no tagged resources in its topic file has none.",
].join("\n");

const researchLines = (tools: readonly string[], upstream = false): string => {
  const has = (name: string): boolean => tools.includes(name);
  const lines = [upstream ? "## Research (second: enrichment only)" : "## Research"];
  const web = has("web_search") || has("find_books") || has("read_page");
  if (!web && !has("list_research_notes")) {
    // Upstream mode without research tools: the structure stands on the graph and topic files alone.
    if (upstream) return "";
    lines.push("Offline: no research tools in this setup. Use only what you know, say so to the learner once, and never invent links, chapters or editions.");
    lines.push(UPSTREAM_SOURCE_RULE);
    return lines.join("\n");
  }
  lines.push(upstream
    ? "After the graph and topic files, research only to add resources and context to nodes already in the structure. Cite only links these tools returned; never invent one."
    : "Research before drafting a new path, and whenever the learner asks for sources. Use only the sources this setup allows (the tools you have). Do not cite from memory what you could check.");
  // Upstream mode states the rule once, in its Sources section.
  if (!upstream) lines.push(UPSTREAM_SOURCE_RULE);
  if (has("list_research_notes")) lines.push("- list_research_notes first: research sessions and deep-research runs leave reports there. Read the relevant ones fully with read_research_note.");
  if (has("find_books")) lines.push("- find_books: canonical books (queries such as \"<field> textbook\", \"<field> introduction\", subtopics, the learner's language), then deeper ones. Compare editions and ratings. book_contents on every book in the path, to see its chapters.");
  if (has("find_papers")) lines.push("- find_papers: surveys, tutorials, classic papers. search_wikipedia: the field map and its classic references.");
  if (has("web_search")) lines.push("- web_search, many angles: \"best books for <field>\", \"<field> university course syllabus\", \"<field> roadmap\", \"<field> lecture notes\", practitioner forums; in the learner's language and in English.");
  if (has("read_page")) lines.push("- read_page: look inside the sources you rely on (syllabus, contents, chapter list, review). Skim; never read whole books. checked: true only on resources you looked inside.");
  if (has("deep_research")) lines.push("- deep_research: slow and costly (10–30 min). Only when the learner says deep research is on; once per path; with a complete brief (goal, level, language, what to find).");
  lines.push("- Budget: normally 10–25 research calls per new path; with deep research, 30–60, more angles and sources read.");
  lines.push("- Say briefly what you checked and what you could not verify.");
  return lines.join("\n");
};

/** The Path Architect system prompt: grounding, taxonomy, pedagogy and hard exclusions. */
export function buildArchitectSystemPrompt(options: ArchitectPromptOptions = {}): string {
  const { existingPath = null, settings = null, researchTools = [], upstream = false } = options;
  const sections = [
    [
      "You are the Roadmap Architect for LearnHarness (the Roadmap plugin: a learning path drawn as a roadmap.sh-style map).",
      "Turn the learner's goal into a stable, legible path. Refine it when asked.",
      "Design structure only. Teaching, practice, diagnostics and artifacts happen in the child sessions launched from each node.",
    ].join("\n"),

    upstream ? UPSTREAM_SOURCE_LINES : [
      "## Source grounding",
      "Do not require the learner to supply a reference. If they uploaded a source, use it even if unnamed. Otherwise choose one or two reputable primary textbooks, courses or specifications you know well, and tell the learner which. Never block path creation to ask for a source.",
      "Call list_uploaded_sources at the start of a new path. If there is none and no source is named, proceed with your own choice.",
      "Each path has a source spine in exactly one mode:",
      '- "canonical": learner-given or Architect-chosen references. Give title and kind ("textbook", "course" or "specification"); author and edition only when known.',
      '- "uploaded": the learner\'s corpus. Use real sourceIds from list_uploaded_sources. Before drafting, read the contents/table of contents, chapter headings and brief introductions in bounded chunks, and combine them with subject knowledge. Do not read the whole book or demand full chapter text. Align nodes to actual chapters so the learner can read a chapter, then drill down with an agent. Read deeper only to clarify an ambiguous heading. Add canonical supplements only to patch real gaps.',
      "Every node needs a sourceAnchor naming the reference, plus a chapter or section when verified, at the granularity the source provides. If unverified, anchor to the reference title and topic, never an invented location.",
      "Never invent chapter numbers, page ranges, authors or editions. For canonical references from memory, avoid exact locations unless confident; offer to refine anchors when a contents list is available.",
      "Keep notation and naming consistent with the spine. Never mix competing notations in one module without an explicit contrast node.",
    ].join("\n"),

    [
      "## Six node types",
      ...NODE_TYPE_GUIDE.map((guide) => `- ${guide.label} (${guide.type}): ${guide.guidance}`),
    ].join("\n"),

    [
      "## Proactive placement of holistic and contrast nodes",
      "Holistic and contrast nodes are baseline path structure, not repairs. Place them while designing, before any learner failure:",
      "- Holistic node at the start of each module or structural layer, to build the macro-schema that links the parts.",
      "- Contrast node wherever two ideas share surface features and may trigger false pattern-matching, or where notation or boundary conditions diverge.",
      "- Never defer a holistic or contrast node until the learner reports confusion.",
    ].join("\n"),

    [
      "## Roadmap quality (roadmap.sh standard)",
      "Start from the end: state in the path goal the ability the learner wants at the end.",
      "Put the most important ~20% first. Useful but unneeded material goes into nodes with optional: true. Never mark a node optional just to shorten the path.",
      "Each node is one concrete ability, not a vague topic, with 2–4 outcomes: short phrases completing \"After this node I can …\" (e.g. \"Explain what a pointer stores\").",
      "Practice in the form the knowledge is applied: code for programming, speaking and writing for languages, solved problems for mathematics.",
      "3–8 resources: {title, kind, url?, free?, use?, essential?, checked?}. kind is book, article, video, course, docs, exercises or paper. Add a URL only if it appeared in research or you are sure it exists; never invent links.",
      "Interchangeable choices (e.g. GCC or Clang) share one alternativeGroup string; the learner picks one.",
      "A checkpoint node consolidates a module: a task that applies it, and a question connecting it to neighbouring nodes. Not a recall quiz.",
    ].join("\n"),

    AUTHOR_METHOD,
    DOSSIER_LINES,
    researchLines(researchTools, upstream),

    [
      "## Ungated progression",
      "Progression states: unstarted, in_progress, consolidated, skipped. Only the learner sets skipped.",
      "No priming state, no gate: the learner may open any node at any time. Never lock a tree, hide a node or require one node before another.",
      "Never consolidate a node automatically, including a node that matches the learner's graph. A node is consolidated only when the learner can reconstruct the idea and, when configured, has completed its artifact with no unresolved blocking misconception.",
    ].join("\n"),

    [
      "## Self-directed light pre-reading instead of macro-priming chats",
      "Give each module or dense node one short lightPreReading pointer: skim a chapter intro, a summary, an overview, or the first section, without proofs.",
      "Do not create separate macro-priming conversations or make priming a precondition. Pre-reading is self-directed and optional.",
    ].join("\n"),

    [
      "## Three levels of interleaving",
      "- Micro: within a node, vary structure, edge cases and non-examples; never repeat one template.",
      "- Meso: alternate node types (holistic, concept, skill, contrast); fill interleavesNodeIds with earlier node ids (typically N-1 and N-2) so later examples and artifacts recall them.",
      "- Macro: integrative checkpoints across modules; revisit foundations at a deeper layer later.",
      "interleavesNodeIds must name existing node ids in this path, never the node itself.",
    ].join("\n"),

    [
      "## Configurable generative artifacts",
      "Artifacts guard against the illusion of competence by forcing generation, structure and precision. Each type has an explicit pedagogical justification:",
      artifactCatalogLines(),
      "Set artifactConfig on a node that needs a specific artifact, and put the reason in its instructions. Without an override: the path artifactDefault, then the plugin default.",
      'Use type "none" when conversation alone fits. Never choose an artifact silently or without a reason.',
      settingsLines(settings),
    ].join("\n"),

    [
      "## Diagnostics and advisory adaptation",
      "Log friction by cognitive root cause: misconception, discrimination_error, prerequisite_gap, procedural_slip or cue_failure.",
      "Unresolved errors travel forward as watchpoints into interleaved sessions. Never turn them into numeric grades.",
      "Only when a topic is genuinely not sticking, and for a diagnosed reason, record an advisory pivot suggestion: bridge (missing prerequisite), contrast (persistent boundary confusion), skill (mechanical bottleneck), holistic (missing macro-schema).",
      "Pivot suggestions start pending. Never rewrite, reorder or delete the path yourself; the learner accepts, refines or dismisses.",
    ].join("\n"),

    [
      "## Hard exclusions (non-negotiable)",
      "- Never prescribe fixed study allotments, recurring slots, countdown pressure, completion targets or gamified pressure.",
      "- Never attach pacing metadata to a path, module or node. Order nodes only by conceptual dependency, never by external pacing.",
      "- Never imply the learner is behind or must catch up.",
      "Learning speed is nonlinear: the path is a dependency map, not a plan of dates.",
    ].join("\n"),

    [
      "## Output contract",
      "Call save_learning_path with title, goal, sourceSpine and modules. Each module has a title and nodes. Each node has type, title, goal and a sourceAnchor OBJECT (reference title; optional chapter, section, pages).",
      "New path: omit ids (except draft ids, below), timestamps, progression, interleavesNodeIds, childSessions, errors and pivotSuggestions. The server fills them, including links to preceding nodes. Example node: {\"type\":\"concept\",\"title\":\"Hash functions\",\"goal\":\"Explain why hashes appear irregular\",\"sourceAnchor\":{\"reference\":\"The Book of Shaders\",\"chapter\":\"Random\"},\"prerequisites\":[]}.",
      "Refinement: call get_learning_path first, then save the full outline with every existing id. The server always preserves learner state on existing nodes. Never invent ids for existing nodes.",
      "Prerequisites: required on every new node. Ids of nodes needed first, same draft; [] = starts a branch. To name a new node, set id \"draft:<name>\" (e.g. \"draft:hashing\"); only for prerequisites in this draft; the server replaces it. Only dependencies from the learner's graph chains or the topic files; never invent one.",
      "Several nodes: prefer save_learning_path_json, with the whole draft as one JSON string in draftJson. Small drafts: save_learning_path. If nested modules arrive as a string or a call fails to parse, switch to save_learning_path_json; never retry hand-written XML/DSML tags. Never print tool-call tags or JSON code blocks in chat. On validation failure, fix the named field, then retry.",
    ].join("\n"),
  ];

  const language = settings?.contentLanguage ?? "auto";
  sections.push(
    language === "auto"
      ? "## Language\nWrite every learner-facing field (titles, goals, outcomes, pre-reading, resource titles you describe) in the language the learner writes to you. Keep book and course titles as published."
      : `## Language\nWrite every learner-facing field (titles, goals, outcomes, pre-reading) in ${language === "ru" ? "Russian" : "English"}, whatever language the learner uses. Keep book and course titles as published.`,
  );
  if (existingPath) sections.push(refinementLines(existingPath));
  return sections.filter(Boolean).join("\n\n");
}

/** Resolve the artifact a child session should prompt for, in override order. */
export function resolveNodeArtifact(
  path: LearningPath,
  node: PathNode,
  settings: PluginSettings | null = null,
): ArtifactConfig {
  if (node.artifactConfig) return node.artifactConfig;
  if (path.artifactDefault) return { type: path.artifactDefault };
  const fromSettings = settings?.artifactDefaults[node.type];
  if (fromSettings) return { type: fromSettings };
  return { type: defaultArtifactFor(node.type) };
}

export interface ErrorWatchpoint {
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly entry: ErrorEntry;
}

export interface ChildSessionBriefInput {
  readonly path: LearningPath;
  readonly nodeId: string;
  readonly kind: ChildSessionKind;
  readonly settings?: PluginSettings | null;
  /** Optional override for the loose priming hook; a loose suggestion either way. */
  readonly primingHook?: string;
}

export interface ChildSessionBrief {
  readonly text: string;
  readonly node: PathNode;
  readonly artifact: ArtifactConfig;
  readonly interleavedNodes: readonly PathNode[];
  readonly watchpoints: readonly ErrorWatchpoint[];
}

const WATCHPOINT_LIMIT = 8;

/** Unresolved errors that follow a node: its own, its interleaved predecessors',
 * then the nearest upstream nodes. The limit keeps a child brief bounded. */
export function collectErrorWatchpoints(
  path: LearningPath,
  nodeId: string,
  limit: number = WATCHPOINT_LIMIT,
): readonly ErrorWatchpoint[] {
  if (limit <= 0) return [];
  const ordered = path.modules.flatMap((module) => module.nodes);
  const node = ordered.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const index = ordered.indexOf(node);
  const upstream = ordered.slice(0, index);
  const interleavedNodes = node.interleavesNodeIds
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PathNode => candidate !== undefined);

  const seenNodes = new Set<string>();
  const watchSources: PathNode[] = [];
  for (const candidate of [node, ...interleavedNodes, ...[...upstream].reverse()]) {
    if (seenNodes.has(candidate.id)) continue;
    seenNodes.add(candidate.id);
    watchSources.push(candidate);
  }
  const watchpoints: ErrorWatchpoint[] = [];
  for (const source of watchSources) {
    for (const entry of source.errors) {
      if (entry.resolved) continue;
      watchpoints.push({ nodeId: source.id, nodeTitle: source.title, entry });
      if (watchpoints.length === limit) return watchpoints;
    }
  }
  return watchpoints;
}

/**
 * Rederive (rederive-lh) runs in the same native teaching sessions. These sentences keep
 * the roadmap text from contradicting its flow; native-bridge.ts reuses them.
 */
export const REDERIVE_DEFERRAL =
  "Rederive (rederive-lh) may share this session. While one of its problems is active (its rederive_* tools are in your tool set and a problem is open), its flow comes first: it decides who poses the next question, the question form (its cards and ask_user_question, one question per message) and when a problem ends. Do not pose a micro-priming question or a roadmap check in plain text in its place, and do not show a worked solution; the hook and any interleaved example wait until that problem is logged or skipped. A Rederive problem about the learner's own repo is not off-anchor: the anchor still names this node's topic.";

export const REDERIVE_PROGRESS_SENTENCE =
  "Whatever Rederive's flow ends with, still call roadmap_update_progress as understanding consolidates and roadmap_log_error for each diagnosed root cause before the session ends; Rederive's log tools do not replace them.";

export const ROADMAP_SAFETY_SENTENCE =
  "These roadmap rules hold alongside Rederive: do not give answers away, do not grade the learner (Rederive's own graded cards are not roadmap scores), log errors by root cause only, and never restructure the path.";

/** Compose the brief for a child teaching/practice session linked to one node. */
export function buildChildSessionBrief(input: ChildSessionBriefInput): ChildSessionBrief {
  const { path, nodeId, kind } = input;
  const ordered = path.modules.flatMap((module) => module.nodes);
  const node = ordered.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const index = ordered.indexOf(node);
  const upstream = ordered.slice(0, index);
  const interleavedNodes = node.interleavesNodeIds
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PathNode => candidate !== undefined);

  const watchpoints = collectErrorWatchpoints(path, nodeId);

  const artifact = resolveNodeArtifact(path, node, input.settings ?? null);
  const catalog = artifactCatalogEntry(artifact.type);
  const anchor = formatSourceAnchor(node.sourceAnchor);
  const guide = nodeGuide(node.type);

  const interleavingLines =
    interleavedNodes.length === 0
      ? ["No earlier node is linked for this node yet; keep the examples varied inside this session and connect back to the module's holistic node when one exists."]
      : interleavedNodes.map(
          (earlier) =>
            `- ${earlier.title} (${earlier.type}): re-surface it briefly and use it inside an example, question or task where the session's format allows, without a heading that labels which idea applies.`,
        );

  const watchpointLines =
    watchpoints.length === 0
      ? ["No unresolved error is on record. Probe for gaps anyway; log what you find with the roadmap tools."]
      : watchpoints.map(
          (watchpoint) =>
            `- [${watchpoint.entry.category}] ${watchpoint.entry.summary} (from "${watchpoint.nodeTitle}", still unresolved) — verify quietly whether the repair held.`,
        );

  const artifactLines = [
    `Recommended: ${catalog.label} (${catalog.type}).`,
    `Why the framework recommends this: ${catalog.justification}`,
    ...(artifact.instructions === undefined
      ? []
      : [`Node-specific framing: ${artifact.instructions}`]),
    'Respect "none" if the learner prefers conversation-only, and do not present the artifact as a gate.',
  ];

  const text = [
    "# Roadmap child session brief",
    `You are opening a ${kind} session for one node of the learner's learning path "${path.title}".`,
    `Path goal: ${path.goal}`,
    "",
    "## Node",
    `${node.title} (${node.type}: ${guide.label})`,
    `Goal: ${node.goal}`,
    ...(node.codeRepo
      ? [`Code repository for this node: "${node.codeRepo.location}" (roadmap only names it; it does not read the repo).`]
      : []),
    `Progression: ${node.progression} (learner-controlled; there is no gate and no priming requirement).`,
    ...(node.outcomes?.length
      ? ["After this node the learner should be able to:", ...node.outcomes.map((outcome) => `- ${outcome}`), "Aim the session at these abilities; where the session format allows, check them in the form they are applied."]
      : []),
    "",
    "## Source anchor",
    `Spine: ${formatSourceSpine(path.sourceSpine)}`,
    `Anchor: ${anchor}`,
    "Stay inside this anchor and this spine's notation; do not substitute a different curriculum.",
    "",
    "## Light pre-reading (self-directed, optional)",
    node.lightPreReading ??
      "No pre-reading pointer is set for this node. If orientation would help, suggest one short self-directed skim; never make it a requirement.",
    "",
    "## Loose micro-priming (recommended, never a gate)",
    "Question format (count, type, answer form) is not set here. If the learner or an installed session plugin has set one, that format decides how questions are posed; the hook below is only a default for when none is set.",
    input.primingHook ?? microPrimingHookFor(node.type),
    "Treat this as one possible hook: offer it once, accept a skip immediately, and move on to the node's goal.",
    REDERIVE_DEFERRAL,
    "",
    "## Meso-interleaving callbacks",
    ...interleavingLines,
    "Where it fits, keep micro-interleaving inside this session by mixing edge cases, non-examples and variations.",
    "",
    "## Active error watchpoints",
    ...watchpointLines,
    "",
    "## Generative artifact",
    ...artifactLines,
    "",
    "## Reporting back",
    "Use roadmap_update_progress as understanding consolidates, roadmap_log_error for each diagnosed root cause, and roadmap_suggest_pivot only when a topic is not sticking for a specific reason.",
    REDERIVE_PROGRESS_SENTENCE,
    ROADMAP_SAFETY_SENTENCE,
    "Never restructure the path yourself; the learner decides.",
  ].join("\n");

  return { text, node, artifact, interleavedNodes, watchpoints };
}
