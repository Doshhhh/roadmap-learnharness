/** Roadmap view (formerly the Learning Paths "Path Hub").
 *
 * Layout after the Learny roadmap mockup:
 * - a toolbar: roadmap switcher, Graph/Tree, Refine, New roadmap;
 * - the roadmap canvas (bottom-up graph with pan/zoom, or a tree);
 * - a side panel with Node / Errors / Architect tabs;
 * - a status line with progress and open errors.
 *
 * Lifecycle: every widget, listener and async load belongs to the per-mount
 * signal. Stale loads are fenced by a request token, and notifications /
 * resyncs re-read authoritative state instead of trusting payloads.
 */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import type {
  ArtifactType,
  ChildSessionKind,
  DisplaySettings,
  LearningPath,
  PathNode,
  PivotSuggestion,
  PluginSettings,
  ProgressionState,
} from "../domain.ts";
import { ARTIFACT_TYPES, DEFAULT_DISPLAY, PROGRESSION_STATES, artifactCatalogEntry, recommendedArtifactsFor } from "../domain.ts";
import { locale, resolveLocale, setLocale, t } from "../i18n.ts";
import type { NativeSessionHost } from "../native-session-host.ts";
import type { Mastery } from "../learner-map.ts";
import type { NodeProposition } from "../node-propositions.ts";
import { nextUpForPath, type NextRecommendation } from "../node-next.ts";
import { createSessionLauncher } from "../session-launcher.ts";
import { consumePathHubTarget, subscribePathHubTarget } from "../session-navigation.ts";
import type { SessionStatus } from "../session-types.ts";
import { EVENT_ARCHITECT_CHANGED, EVENT_PATHS_CHANGED, EVENT_SETTINGS_CHANGED } from "../topics.ts";
import { createArchitectPane } from "./architect-pane.ts";
import { button, el } from "./dom.ts";
import type { ErrorLedgerChange } from "./error-ledger.ts";
import { ICONS, setIcon } from "./icons.ts";
import { createNodeInspector } from "./node-inspector.ts";
import type { NodeInspectorChange } from "./node-inspector.ts";
import { pivotDiscussionPrompt } from "./pivot-banner.ts";
import type { PivotDecision } from "./pivot-banner.ts";
import { createRoadmapCanvas } from "./roadmap-canvas.ts";
import type { ViewMode } from "./roadmap-canvas.ts";
import { defaultExpandedModule, isDone, progressCounts } from "./roadmap-layout.ts";
import { openLinkExistingSessionDialog } from "./session-dialogs.ts";
import { artifactLabel } from "./labels.ts";

/** The backend's `paths.list` projection; not a second full path payload. */
export interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly sourceMode: "canonical" | "uploaded";
  readonly architectChatId?: string | null;
}

/** A roadmap file the store refused (for example after a Git merge); it is hidden and never written. */
interface RefusedRoadmap {
  readonly filename: string;
  readonly code: string;
}

interface PathsListResult {
  readonly paths: readonly PathSummary[];
  readonly refused?: readonly RefusedRoadmap[];
}

/** The hub banner text for refused roadmap files, or null when every file read cleanly. */
function refusedNotice(refused: readonly RefusedRoadmap[] | undefined): string | null {
  if (!refused || refused.length === 0) return null;
  return refused
    .map((entry) => t(entry.code === "newer-schema" ? "error.refusedNewer" : "error.refused", { file: entry.filename }))
    .join(" ");
}

interface PathResult {
  readonly path: LearningPath | null;
}

type Tab = "node" | "errors" | "architect";

function nodeById(path: LearningPath, nodeId: string | null): PathNode | null {
  if (!nodeId) return null;
  for (const module of path.modules) {
    const node = module.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node;
  }
  return null;
}

/** Next-up recommendations. A roadmap the ranking cannot read yields none rather than breaking the view. */
function nextRecommendations(path: LearningPath, mastery: readonly Mastery[]): NextRecommendation[] {
  try {
    return nextUpForPath(path, undefined, mastery);
  } catch {
    return [];
  }
}

export function countNodes(path: LearningPath): { total: number; consolidated: number; inProgress: number; errors: number } {
  let total = 0;
  let consolidated = 0;
  let inProgress = 0;
  let errors = 0;
  for (const module of path.modules) {
    const counts = progressCounts(module.nodes);
    total += counts.total;
    consolidated += counts.done;
    for (const node of module.nodes) {
      errors += node.errors.filter((entry) => !entry.resolved).length;
      if (node.progression === "in_progress") inProgress += 1;
    }
  }
  return { total, consolidated, inProgress, errors };
}

/** Short spine label for the toolbar, e.g. "K&R, 2nd ed.". */
function spineLabel(path: LearningPath): string {
  if (path.sourceSpine.mode === "uploaded") return path.sourceSpine.sources.map((source) => source.name).join(", ");
  return path.sourceSpine.references.map((reference) => reference.title).join(", ");
}

export interface PathHubOptions {
  /** Test seam: inject the native session host so no network/storage is touched. */
  readonly sessionHost?: NativeSessionHost;
  /** Rebuild the view when the saved interface language differs from the active one. */
  readonly onLocaleChange?: () => void;
}

export function mountPathHub(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PathHubOptions = {},
): () => void {
  const document = container.ownerDocument;
  const root = el(document, "div", "rm-hub");
  container.append(root);

  // ── Toolbar ──────────────────────────────────────────────────────────
  const toolbar = el(document, "header", "rm-top");
  const crumb = el(document, "div", "rm-crumb");
  const pathSwitch = el(document, "button", "rm-crumb-path");
  pathSwitch.type = "button";
  const pathSwitchTitle = el(document, "span");
  const pathSwitchChevron = el(document, "span", "rm-crumb-chevron");
  setIcon(pathSwitchChevron, ICONS.chevronDown);
  pathSwitch.append(pathSwitchTitle, pathSwitchChevron);
  crumb.append(pathSwitch);
  const spine = el(document, "span", "rm-top-spine");
  const segment = el(document, "div", "rm-seg");
  const graphTab = el(document, "button");
  const treeTab = el(document, "button");
  graphTab.type = treeTab.type = "button";
  segment.append(graphTab, treeTab);
  const actions = el(document, "div", "rm-top-actions");
  toolbar.append(crumb, el(document, "span", "rm-grow"), spine, segment, actions);
  root.append(toolbar);

  const hubError = el(document, "p", "rm-hub-error");
  hubError.setAttribute("role", "alert");
  hubError.hidden = true;
  root.append(hubError);

  // ── Body: canvas + side panel ────────────────────────────────────────
  const body = el(document, "div", "rm-body");
  const canvasHost = el(document, "section", "rm-canvas-host");
  const empty = el(document, "div", "rm-empty");
  empty.hidden = true;
  canvasHost.append(empty);
  const side = el(document, "aside", "rm-side");
  const tabs = el(document, "div", "rm-tabs");
  const nodeTabButton = el(document, "button", "rm-tab");
  const errorsTabButton = el(document, "button", "rm-tab");
  const architectTabButton = el(document, "button", "rm-tab");
  const closeSide = el(document, "button", "rm-icon-btn rm-tabs-close");
  for (const node of [nodeTabButton, errorsTabButton, architectTabButton, closeSide]) node.type = "button";
  setIcon(closeSide, ICONS.close);
  tabs.append(nodeTabButton, errorsTabButton, architectTabButton, el(document, "span", "rm-grow"), closeSide);
  const nodePanel = el(document, "div", "rm-panel rm-panel-node");
  const errorsPanel = el(document, "div", "rm-panel rm-panel-errors");
  const architectPanel = el(document, "div", "rm-panel rm-panel-architect lp-architect-pane");
  side.append(tabs, nodePanel, errorsPanel, architectPanel);
  body.append(canvasHost, side);
  root.append(body);

  const status = el(document, "footer", "rm-status");
  const statusSummary = el(document, "span", "rm-status-summary");
  statusSummary.setAttribute("aria-live", "polite");
  const statusErrors = el(document, "button", "rm-status-errors");
  statusErrors.type = "button";
  const statusNext = el(document, "div", "rm-status-next");
  statusNext.hidden = true;
  status.append(el(document, "span", "rm-grow"), statusSummary, statusNext, statusErrors);
  root.append(status);

  // ── State ────────────────────────────────────────────────────────────
  let summaries: PathSummary[] = [];
  /** Banner text for refused roadmap files from the last list; shown whenever no other error is. */
  let refused: string | null = null;
  let path: LearningPath | null = null;
  let selectedPathId: string | null = null;
  let selectedNodeId: string | null = null;
  let expandedModuleId: string | null = null;
  let display: DisplaySettings = DEFAULT_DISPLAY;
  let view: ViewMode = display.defaultView;
  let tab: Tab = "node";
  let sideOpen = true;
  let autoLoadedPathId: string | null = null;
  let createdPathId: string | null = null;
  /** Graph topics the learner has studied, from the backend brief; read only for the empty state. */
  let graphTopics = 0;
  let emptyControls = new AbortController();
  let loadToken = 0;
  let disposed = false;
  let startingSession = false;
  let menuHandle: { dispose(): void } | null = null;
  let toolbarControls = new AbortController();
  const mountedLocale = locale();
  const chatStatuses = new Map<string, SessionStatus>();
  // Knowledge Graph mastery for evidence and next-up. A failed read leaves `masteryReady` false: no
  // evidence, and no next-up list, rather than a ranking that treats every topic as unseen.
  let mastery: readonly Mastery[] = [];
  let masteryReady = false;

  const pane = createArchitectPane(ctx, architectPanel, signal);
  const launcher = createSessionLauncher(ctx, { host: options.sessionHost });
  const canvas = createRoadmapCanvas(document, canvasHost, signal, {
    selectNode(nodeId) {
      selectNode(nodeId);
    },
    toggleModule(moduleId) {
      if (disposed || signal.aborted) return;
      expandedModuleId = expandedModuleId === moduleId && view === "tree" ? null : moduleId;
      renderCanvas();
    },
  });
  const inspector = createNodeInspector(ctx, nodePanel, signal, {
    errorsContainer: errorsPanel,
    openSession(chatId) {
      if (!signal.aborted && !disposed) ctx.app.openSession(chatId);
    },
    startSession(kind) {
      return startChildSession(kind);
    },
    linkExistingSession() {
      openLinkExisting();
    },
    unlinkSession(chatId) {
      return unlinkSession(chatId);
    },
    knowledgeMastery: () => mastery,
    nodePropositions: (node) => readNodePropositions(node),
    showPatternHints: () => display.patternHints,
    chatStatus: chatStatuses,
    selectNode(nodeId) {
      selectNode(nodeId);
    },
    updateNode(change) {
      return updateNode(change);
    },
    updateError(errorId, change) {
      return updateError(errorId, change);
    },
    decidePivot(pivotId, decision) {
      return decidePivot(pivotId, decision);
    },
    discussPivot(pivot, node) {
      return discussPivot(pivot, node);
    },
    findResources(node) {
      return askArchitect(t("prompt.findResources", { title: node.title, id: node.id }));
    },
  });

  const live = (token: number): boolean => !disposed && !signal.aborted && token === loadToken;
  const problemText = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

  function showError(message: string | null): void {
    if (disposed || signal.aborted) return;
    hubError.textContent = message ?? "";
    hubError.hidden = message === null;
  }

  function setTab(next: Tab): void {
    if (disposed || signal.aborted) return;
    tab = next;
    const reopened = !sideOpen;
    sideOpen = true;
    renderSide();
    if (reopened) renderCanvas();
  }

  function selectNode(nodeId: string | null): void {
    if (disposed || signal.aborted) return;
    selectedNodeId = nodeId;
    if (path && nodeId) {
      const owner = path.modules.find((module) => module.nodes.some((node) => node.id === nodeId));
      if (owner) expandedModuleId = owner.id;
      tab = tab === "architect" ? "node" : tab;
      sideOpen = true;
    }
    renderInspector();
    renderSide();
    renderCanvas();
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function renderToolbar(): void {
    pathSwitchTitle.textContent = path?.title ?? summaries.find((entry) => entry.id === selectedPathId)?.title ?? "—";
    pathSwitch.disabled = summaries.length === 0;
    spine.textContent = path ? spineLabel(path) : "";
    spine.title = spine.textContent;
    graphTab.textContent = t("view.graph");
    treeTab.textContent = t("view.tree");
    graphTab.className = view === "graph" ? "rm-on" : "";
    treeTab.className = view === "tree" ? "rm-on" : "";
    segment.hidden = path === null;
    toolbarControls.abort();
    toolbarControls = new AbortController();
    const scoped = AbortSignal.any([signal, toolbarControls.signal]);
    const refine = button(document, t("action.refine"), () => openArchitectForPath(), scoped, {
      variant: "outline",
      icon: ICONS.sparkle,
      className: tab === "architect" && sideOpen ? "rm-active" : "",
    });
    refine.disabled = path === null;
    actions.replaceChildren(
      refine,
      button(document, t("action.new"), () => startNewRoadmap(), scoped, { variant: "outline" }),
    );
  }

  /** The create-roadmap path: open the Architect on a fresh draft. */
  function startNewRoadmap(): void {
    setTab("architect");
    pane.startNew();
  }

  /** "Build from my graph": a fresh Architect draft whose first message carries the learner's graph (learnerGraph). */
  async function buildFromGraph(): Promise<void> {
    if (disposed || signal.aborted) return;
    setTab("architect");
    pane.startNew();
    await pane.discuss(t("graphEmpty.prompt"), { learnerGraph: true });
  }

  function renderSide(): void {
    if (disposed || signal.aborted) return;
    const node = path ? nodeById(path, selectedNodeId) : null;
    const errors = node ? node.errors.filter((entry) => !entry.resolved).length : 0;
    if (errors === 0 && tab === "errors") tab = "node";
    errorsTabButton.hidden = errors === 0;
    nodeTabButton.textContent = t("tab.node");
    errorsTabButton.textContent = errors > 0 ? `${t("tab.errors")} · ${errors}` : t("tab.errors");
    architectTabButton.textContent = t("tab.architect");
    nodeTabButton.classList.toggle("rm-on", tab === "node");
    errorsTabButton.classList.toggle("rm-on", tab === "errors");
    architectTabButton.classList.toggle("rm-on", tab === "architect");
    nodePanel.hidden = tab !== "node";
    errorsPanel.hidden = tab !== "errors";
    architectPanel.hidden = tab !== "architect";
    // Without a roadmap the Architect is how one is made: keep it visible.
    side.hidden = !sideOpen && path !== null;
    closeSide.hidden = path === null;
    renderToolbar();
  }

  function renderCanvas(): void {
    if (disposed || signal.aborted) return;
    empty.hidden = path !== null;
    if (!path) {
      renderEmpty();
      canvasHost.dataset.empty = "true";
      return;
    }
    delete canvasHost.dataset.empty;
    canvas.render({ path, selectedNodeId, expandedModuleId, view, showOptional: display.showOptional, showLegend: side.hidden });
  }

  /** Empty state: the Architect text, plus "Build from my graph" once the graph has a topic. */
  function renderEmpty(): void {
    emptyControls.abort();
    emptyControls = new AbortController();
    const scoped = AbortSignal.any([signal, emptyControls.signal]);
    const hasGraph = graphTopics > 0;
    const build = button(document, t("graphEmpty.build"), () => void buildFromGraph(), scoped, {
      variant: "outline",
      icon: ICONS.sparkle,
      className: "rm-empty-build",
    });
    build.disabled = !hasGraph;
    const actions = el(document, "div", "rm-empty-actions");
    actions.append(build);
    if (!hasGraph) actions.append(el(document, "p", "rm-muted rm-empty-hint", t("graphEmpty.hint")));
    empty.replaceChildren(
      el(document, "h2", "rm-empty-title", t("empty.title")),
      el(document, "p", "rm-muted", t("empty.text")),
      actions,
    );
  }

  function renderInspector(): void {
    if (disposed || signal.aborted) return;
    inspector.render(path, path ? nodeById(path, selectedNodeId) : null);
  }

  function renderStatus(): void {
    if (!path) {
      statusSummary.textContent = "";
      statusErrors.hidden = true;
      delete statusSummary.dataset.total;
      return;
    }
    const { total, consolidated, inProgress, errors } = countNodes(path);
    statusSummary.textContent = t("foot.summary", { done: consolidated, total, progress: inProgress });
    statusSummary.dataset.total = String(total);
    statusSummary.dataset.consolidated = String(consolidated);
    statusSummary.dataset.inProgress = String(inProgress);
    statusErrors.hidden = errors === 0;
    statusErrors.replaceChildren();
    const icon = el(document, "span", "rm-warn-icon");
    setIcon(icon, ICONS.warn);
    statusErrors.append(icon, el(document, "span", undefined, errors === 1 ? t("foot.error1") : t("foot.errors", { n: errors })));
    renderNext();
  }

  /** "Next up": selecting an item opens it in the node panel, which holds Lesson and Practice. Nothing is gated. */
  function renderNext(): void {
    statusNext.replaceChildren();
    const recommendations = path && masteryReady ? nextRecommendations(path, mastery) : [];
    statusNext.hidden = recommendations.length === 0;
    if (!path || recommendations.length === 0) return;
    statusNext.append(el(document, "span", "rm-status-next-label", t("next.title")));
    for (const entry of recommendations) {
      const target = nodeById(path, entry.nodeId);
      if (!target) continue;
      const item = el(document, "span", "rm-status-next-item");
      item.append(
        button(document, target.title, () => selectNode(target.id), signal, { variant: "ghost", className: "rm-status-next-node" }),
        el(document, "span", "rm-status-next-why", entry.reasons.map((reason) => t(reason.key, reason.vars)).join(" · ")),
      );
      statusNext.append(item);
    }
  }

  /** Light themes need a darker accent; read the effective page background. */
  function syncThemeMode(): void {
    const style = document.defaultView?.getComputedStyle?.(root);
    const match = style ? /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(style.backgroundColor) : null;
    if (!match) return;
    const [r, g, b] = match.slice(1, 4).map(Number) as [number, number, number];
    container.dataset.mode = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "light" : "dark";
  }

  function renderAll(): void {
    if (disposed || signal.aborted) return;
    syncThemeMode();
    root.dataset.hasPath = path ? "true" : "false";
    renderSide();
    renderCanvas();
    renderInspector();
    renderStatus();
  }

  function ensureSelection(): void {
    if (!path) {
      selectedNodeId = null;
      expandedModuleId = null;
      return;
    }
    if (!nodeById(path, selectedNodeId)) {
      // Prefer the first node still in work, so the panel opens where the learner is.
      const nodes = path.modules.flatMap((module) => module.nodes);
      selectedNodeId = (nodes.find((node) => node.progression === "in_progress") ?? nodes.find((node) => !isDone(node) && !node.optional) ?? nodes[0])?.id ?? null;
    }
    if (!expandedModuleId || !path.modules.some((module) => module.id === expandedModuleId)) {
      expandedModuleId = defaultExpandedModule(path, selectedNodeId);
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────
  async function loadDisplay(): Promise<void> {
    try {
      const result = await ctx.call<{ settings: PluginSettings }>("settings.get");
      if (disposed || signal.aborted) return;
      const next = result.settings?.display ?? DEFAULT_DISPLAY;
      const viewChanged = next.defaultView !== display.defaultView;
      display = next;
      if (viewChanged) view = display.defaultView;
    } catch {
      display = DEFAULT_DISPLAY;
    }
    const wanted = resolveLocale(display.language);
    if (wanted !== locale()) {
      setLocale(wanted);
      // Static labels were built in the old language: let the owner rebuild the view.
      if (options.onLocaleChange && !disposed && !signal.aborted) {
        options.onLocaleChange();
        return;
      }
    }
  }

  async function refreshChatStatuses(token: number, pathId: string): Promise<void> {
    if (disposed || signal.aborted) return;
    try {
      const result = await ctx.call<{ sessions: readonly SessionStatus[] }>("sessions.status", { pathId });
      if (!live(token)) return;
      chatStatuses.clear();
      for (const session of result.sessions ?? []) chatStatuses.set(session.chatId, session);
    } catch {
      if (live(token)) chatStatuses.clear();
    }
  }

  async function refreshAll(): Promise<void> {
    if (disposed || signal.aborted) return;
    const token = ++loadToken;
    const target = consumePathHubTarget();
    if (target) {
      selectedPathId = target.pathId;
      selectedNodeId = target.nodeId;
      expandedModuleId = null;
    }
    try {
      const listed = await ctx.call<PathsListResult>("paths.list");
      if (!live(token)) return;
      summaries = [...(listed.paths ?? [])];
      refused = refusedNotice(listed.refused);
      if (createdPathId) {
        const created = summaries.find((entry) => entry.id === createdPathId);
        createdPathId = null;
        if (created?.architectChatId && created.architectChatId === pane.conversationId()) {
          selectedPathId = created.id;
          selectedNodeId = null;
          expandedModuleId = null;
        }
      }
      if (!selectedPathId || !summaries.some((entry) => entry.id === selectedPathId)) {
        selectedPathId = summaries[0]?.id ?? null;
        if (target) selectedNodeId = null;
      }
      let loaded: LearningPath | null = null;
      if (selectedPathId) {
        const result = await ctx.call<PathResult>("paths.get", { id: selectedPathId });
        if (!live(token)) return;
        loaded = result.path;
      }
      path = loaded;
      if (path) {
        await refreshChatStatuses(token, path.id);
        if (!live(token)) return;
        const read = await readKnowledgeMastery();
        if (!live(token)) return;
        mastery = read ?? [];
        masteryReady = read !== null;
      } else {
        chatStatuses.clear();
        tab = "architect";
        graphTopics = await readGraphTopicCount();
        if (!live(token)) return;
      }
      ensureSelection();
      showError(refused);
      renderAll();

      if (path?.architectChatId && !pane.isNewDraft() && path.id !== autoLoadedPathId) {
        autoLoadedPathId = path.id;
        if (pane.conversationId() !== path.architectChatId) await pane.load(path.architectChatId);
      }
    } catch (problem) {
      if (!live(token)) return;
      showError(t("error.load", { message: problemText(problem) }));
    }
  }

  /** Knowledge Graph mastery from `graph.mastery`. Null when the read fails, so callers show no evidence. */
  async function readKnowledgeMastery(): Promise<readonly Mastery[] | null> {
    try {
      const result = await ctx.call<{ mastery: readonly Mastery[] }>("graph.mastery");
      return Array.isArray(result.mastery) ? result.mastery : null;
    } catch {
      return null;
    }
  }

  /** One saved node's graph propositions, from `graph.propositions` (the backend reads the node's own chat links). Null when the read fails. */
  async function readNodePropositions(node: PathNode): Promise<readonly NodeProposition[] | null> {
    if (!path) return null;
    try {
      const result = await ctx.call<{ propositions: readonly NodeProposition[] }>("graph.propositions", {
        pathId: path.id,
        nodeId: node.id,
      });
      return Array.isArray(result.propositions) ? result.propositions : null;
    } catch {
      return null;
    }
  }

  /** Topic count from the backend brief. A failed read leaves the graph-build button disabled. */
  async function readGraphTopicCount(): Promise<number> {
    try {
      const result = await ctx.call<{ topics: number }>("graph.topicCount");
      return typeof result.topics === "number" ? result.topics : 0;
    } catch {
      return 0;
    }
  }

  async function selectPath(pathId: string): Promise<void> {
    if (disposed || signal.aborted || pathId === selectedPathId) return;
    selectedPathId = pathId;
    selectedNodeId = null;
    expandedModuleId = null;
    await refreshAll();
    if (path?.id === pathId && path.architectChatId && pane.isNewDraft()) {
      autoLoadedPathId = path.id;
      await pane.load(path.architectChatId);
    }
  }

  async function mutate(run: () => Promise<{ path: LearningPath }>, failure: "error.save" | "error.ledger" | "error.pivot" | "error.unlink"): Promise<{ path: LearningPath } | null> {
    try {
      const result = await run();
      if (disposed || signal.aborted) return null;
      path = result.path;
      ensureSelection();
      showError(refused);
      return result;
    } catch (problem) {
      if (!disposed && !signal.aborted) showError(t(failure, { message: problemText(problem) }));
      return null;
    }
  }

  async function updateNode(change: NodeInspectorChange): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const pathId = path.id;
    const nodeId = selectedNodeId;
    if (await mutate(() => ctx.call("paths.updateNode", { pathId, nodeId, ...change }), "error.save")) renderAll();
  }

  async function updateError(errorId: string, change: ErrorLedgerChange): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const pathId = path.id;
    const nodeId = selectedNodeId;
    if (await mutate(() => ctx.call("errors.update", { pathId, nodeId, errorId, ...change }), "error.ledger")) renderAll();
  }

  async function decidePivot(pivotId: string, decision: PivotDecision): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const pathId = path.id;
    const nodeId = selectedNodeId;
    const result = (await mutate(
      () => ctx.call("pivots.resolve", { pathId, nodeId, pivotId, action: decision }),
      "error.pivot",
    )) as { path: LearningPath; insertedNode?: PathNode | null } | null;
    if (!result) return;
    if (decision === "accept" && result.insertedNode) {
      selectedNodeId = result.insertedNode.id;
      ensureSelection();
    }
    renderAll();
  }

  /** A "Build" pressed on a proposal card in a session: open a new Architect conversation with the dossier. */
  async function takePendingBuild(): Promise<void> {
    try {
      const pending = await ctx.call<{ noteId: string | null; message?: string }>("diagnostic.takePending", { locale: locale() });
      if (!pending.noteId || !pending.message || disposed || signal.aborted) return;
      setTab("architect");
      pane.startNew();
      await pane.discuss(pending.message);
    } catch {
      // Nothing waiting, or the backend is older; the view works as usual.
    }
  }

  async function askArchitect(text: string): Promise<void> {
    if (disposed || signal.aborted) return;
    setTab("architect");
    if (path?.architectChatId && pane.conversationId() !== path.architectChatId) {
      await pane.load(path.architectChatId);
      if (disposed || signal.aborted) return;
    }
    await pane.discuss(text);
  }

  async function discussPivot(pivot: PivotSuggestion, node: PathNode): Promise<void> {
    await askArchitect(pivotDiscussionPrompt(pivot, node));
  }

  function openArchitectForPath(): void {
    if (disposed || signal.aborted) return;
    if (tab === "architect" && sideOpen) {
      setTab("node");
      return;
    }
    setTab("architect");
    if (path?.architectChatId) {
      if (pane.conversationId() !== path.architectChatId) void pane.load(path.architectChatId);
    } else if (!pane.conversationId()) {
      pane.startNew();
    }
  }

  async function startChildSession(kind: ChildSessionKind): Promise<void> {
    if (disposed || signal.aborted || startingSession || !path || !selectedNodeId) return;
    startingSession = true;
    try {
      await launcher.start({ pathId: path.id, nodeId: selectedNodeId, kind });
      if (disposed || signal.aborted) return;
      await refreshAll();
    } catch (problem) {
      if (!disposed && !signal.aborted) showError(t("error.start", { message: problemText(problem) }));
    } finally {
      startingSession = false;
    }
  }

  function openLinkExisting(): void {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const node = nodeById(path, selectedNodeId);
    if (!node) return;
    openLinkExistingSessionDialog(ctx, {
      launcher,
      pathId: path.id,
      nodeId: node.id,
      nodeTitle: node.title,
      signal,
      onLinked() {
        void refreshAll();
      },
    });
  }

  async function unlinkSession(chatId: string): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const pathId = path.id;
    const nodeId = selectedNodeId;
    const result = await mutate(() => ctx.call("sessions.unlink", { pathId, nodeId, chatId }), "error.unlink");
    if (!result) return;
    await refreshChatStatuses(loadToken, result.path.id);
    if (!disposed && !signal.aborted) renderAll();
  }

  // ── Events ───────────────────────────────────────────────────────────
  pathSwitch.addEventListener("click", () => {
    if (disposed || signal.aborted || summaries.length === 0) return;
    menuHandle?.dispose();
    menuHandle = ctx.ui.openMenu(
      pathSwitch,
      {
        label: t("crumb.root"),
        preferredSide: "down",
        items: summaries.map((summary) => ({
          key: summary.id,
          label: summary.id === selectedPathId ? `✓ ${summary.title}` : summary.title,
          onSelect: () => void selectPath(summary.id),
        })),
      },
      { signal },
    );
  }, { signal });
  graphTab.addEventListener("click", () => {
    view = "graph";
    renderCanvas();
    renderToolbar();
  }, { signal });
  treeTab.addEventListener("click", () => {
    view = "tree";
    renderCanvas();
    renderToolbar();
  }, { signal });
  nodeTabButton.addEventListener("click", () => setTab("node"), { signal });
  errorsTabButton.addEventListener("click", () => setTab("errors"), { signal });
  architectTabButton.addEventListener("click", () => openArchitectForPath(), { signal });
  closeSide.addEventListener("click", () => {
    sideOpen = false;
    renderSide();
    renderCanvas();
  }, { signal });
  statusErrors.addEventListener("click", () => {
    if (!path) return;
    const withError = path.modules.flatMap((module) => module.nodes).find((node) => node.errors.some((entry) => !entry.resolved));
    if (withError) {
      selectNode(withError.id);
      setTab("errors");
    }
  }, { signal });

  const offNotification = ctx.onNotification((event) => {
    if (signal.aborted || disposed) return;
    if (event.topic === EVENT_PATHS_CHANGED) {
      const data = event.data as { id?: unknown; created?: unknown } | undefined;
      if (data?.created === true && typeof data.id === "string") createdPathId = data.id;
      void refreshAll();
      return;
    }
    if (event.topic === EVENT_SETTINGS_CHANGED) {
      void loadDisplay().then(() => {
        if (!disposed && !signal.aborted && locale() === mountedLocale) renderAll();
      });
      return;
    }
    if (event.topic === EVENT_ARCHITECT_CHANGED) {
      const data = event.data as { id?: unknown; messageCount?: unknown } | undefined;
      const id = typeof data?.id === "string" ? data.id : null;
      const messageCount = typeof data?.messageCount === "number" ? data.messageCount : undefined;
      if (id && id === pane.conversationId()) void pane.refresh(id, messageCount);
    }
  });

  const offNavigation = subscribePathHubTarget((target) => {
    if (signal.aborted || disposed) return;
    consumePathHubTarget();
    selectedPathId = target.pathId;
    selectedNodeId = target.nodeId;
    expandedModuleId = null;
    if (path?.id === target.pathId) {
      ensureSelection();
      tab = "node";
      sideOpen = true;
      renderAll();
      return;
    }
    void refreshAll();
  });

  const offResync = ctx.onResync(() => {
    if (signal.aborted || disposed) return;
    void refreshAll();
    const id = pane.conversationId();
    if (id) void pane.load(id);
  });

  const onAbort = (): void => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    offNotification();
    offNavigation();
    offResync();
    menuHandle?.dispose();
    toolbarControls.abort();
    emptyControls.abort();
    canvas.dispose();
    inspector.dispose();
    pane.dispose();
    root.remove();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  void loadDisplay().then(() => {
    if (disposed || signal.aborted || locale() !== mountedLocale) return;
    renderAll();
    return refreshAll().then(() => takePendingBuild());
  });

  return () => {
    signal.removeEventListener("abort", onAbort);
    onAbort();
  };
}

/** Exported for the inspector and tests: every artifact the UI can persist. */
export const PATH_HUB_ARTIFACTS: readonly ArtifactType[] = ARTIFACT_TYPES;

/** Exported for tests: the ungated progression states. */
export const PATH_HUB_PROGRESSIONS: readonly ProgressionState[] = PROGRESSION_STATES;

export function describeArtifact(type: ArtifactType): string {
  return `${artifactLabel(type)}: ${artifactCatalogEntry(type).justification}`;
}

export function firstRecommendedArtifact(node: PathNode): ArtifactType {
  return recommendedArtifactsFor(node.type)[0] ?? "none";
}
