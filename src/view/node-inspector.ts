/** Node panel ("Node" tab) for the Roadmap view, after the Learny node mockup.
 *
 * Shows one node: status, marks, goal, "after this node I can", source and
 * pre-reading, typed resources, interleaved prior nodes, linked sessions with
 * their focused minutes, and the artifact with its reason. The error ledger is
 * rendered into the separate "Errors" tab container.
 *
 * Controlled: `render` receives the authoritative path and node; edits are
 * reported to the caller.
 */
import type { PluginDialogProps, PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { ARTIFACT_CATALOG, PROGRESSION_STATES, artifactCatalogEntry, recommendedArtifactsFor } from "../domain.ts";
import type {
  ArtifactType,
  ChildSessionKind,
  LearningPath,
  NodeResource,
  PathNode,
  PivotSuggestion,
  ProgressionState,
  SourceAnchor,
} from "../domain.ts";
import { locale, t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
import type { Mastery } from "../learner-map.ts";
import { nodeEvidence } from "../node-evidence.ts";
import { nodePatternHintKey } from "../pattern-hint.ts";
import type { NodeProposition } from "../node-propositions.ts";
import type { EvidenceSuggestion, NodeEvidence } from "../node-evidence.ts";
import type { SessionStatus } from "../session-types.ts";
import { button, el, shortDate } from "./dom.ts";
import { createErrorLedger } from "./error-ledger.ts";
import type { ErrorLedgerChange } from "./error-ledger.ts";
import { ICONS, setIcon, statusIcon } from "./icons.ts";
import { createPivotBanner } from "./pivot-banner.ts";
import type { PivotDecision } from "./pivot-banner.ts";

export interface NodeInspectorChange {
  readonly progression?: ProgressionState;
  readonly artifactType?: ArtifactType | null;
}

export interface NodeInspectorOptions {
  openSession(chatId: string): void;
  linkExistingSession(): void | Promise<void>;
  startSession(kind: ChildSessionKind): void | Promise<void>;
  unlinkSession(chatId: string): void | Promise<void>;
  chatStatus?: ReadonlyMap<string, SessionStatus>;
  selectNode(nodeId: string): void;
  updateNode(change: NodeInspectorChange): void | Promise<void>;
  updateError(errorId: string, change: ErrorLedgerChange): void | Promise<void>;
  decidePivot(pivotId: string, decision: PivotDecision): void | Promise<void>;
  discussPivot(pivot: PivotSuggestion, node: PathNode): void | Promise<void>;
  /** Ask the Architect to find resources for a node. */
  findResources?(node: PathNode): void | Promise<void>;
  /** Where the error ledger renders (the "Errors" tab); defaults to the node panel. */
  errorsContainer?: HTMLElement;
  /** Knowledge Graph mastery for "studied elsewhere" evidence, read on each render. Absent: no evidence block. */
  knowledgeMastery?(): readonly Mastery[];
  /** Read on each render: whether the one-line question-template hint shows. Absent means shown. */
  showPatternHints?(): boolean;
  /** The learner's graph propositions linked to this node, for the Flashcard seed action. Null when the read fails. */
  nodePropositions?(node: PathNode): Promise<readonly NodeProposition[] | null>;
}

export interface NodeInspector {
  render(path: LearningPath | null, node: PathNode | null): void;
  dispose(): void;
}

/** Per-node override, then path default, then the framework's recommendation. */
export function effectiveArtifact(path: LearningPath, node: PathNode): ArtifactType {
  return node.artifactConfig?.type ?? path.artifactDefault ?? recommendedArtifactsFor(node.type)[0] ?? "none";
}

const RESOURCE_ICON: Record<NodeResource["kind"], string> = {
  book: ICONS.book,
  article: ICONS.article,
  video: ICONS.video,
  course: ICONS.course,
  docs: ICONS.docs,
  exercises: ICONS.exercises,
  paper: ICONS.article,
};

/** "K&R, ch. 5 · §5.1 · pp. 93–117" in the active locale. */
export function formatAnchor(anchor: SourceAnchor): string {
  const ru = locale() === "ru";
  const parts = [anchor.reference];
  if (anchor.chapter) {
    // The Architect sometimes writes "Ch. 8" or "Глава 8" itself; never print "ch. Ch. 8".
    const labelled = /^(ch(apter)?|гл(ава)?|part|часть|lecture|лекция|module|модуль|unit|week)\b\.?/i.test(anchor.chapter.trim());
    parts.push(labelled ? anchor.chapter.trim() : `${ru ? "гл." : "ch."} ${anchor.chapter}`);
  }
  if (anchor.section) parts.push(`§${anchor.section.replace(/^§/, "")}`);
  if (anchor.pages) parts.push(`${ru ? "стр." : "pp."} ${anchor.pages}`);
  return parts.join(" · ");
}

function findNode(path: LearningPath, nodeId: string): PathNode | null {
  for (const module of path.modules) {
    const node = module.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node;
  }
  return null;
}

export function artifactName(type: ArtifactType): string {
  return t(`art.${type}` as MessageKey);
}

export function createNodeInspector(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: NodeInspectorOptions,
): NodeInspector {
  const document = container.ownerDocument;
  const root = el(document, "div", "rm-insp");
  root.setAttribute("aria-label", t("tab.node"));
  const body = el(document, "div", "rm-insp-body");
  const footer = el(document, "div", "rm-insp-foot");
  root.append(body, footer);
  container.append(root);

  const pivotContainer = el(document, "div", "rm-pivot-host");
  const pivotBanner = createPivotBanner(ctx, pivotContainer, signal, { decide: options.decidePivot, discuss: options.discussPivot });
  const errorLedger = createErrorLedger(ctx, options.errorsContainer ?? body, signal, {
    update: options.updateError,
    selectNode: options.selectNode,
  });

  let handles: PluginWidgetHandle<unknown>[] = [];
  let controller = new AbortController();
  let disposed = false;
  const scoped = (): AbortSignal => AbortSignal.any([signal, controller.signal]);
  const localeTag = (): string => (locale() === "ru" ? "ru-RU" : "en-US");

  const clear = (): void => {
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    controller.abort();
    controller = new AbortController();
    body.replaceChildren();
    footer.replaceChildren();
  };

  const menu = (anchor: HTMLElement, label: string, items: { key: string; label: string; onSelect: () => void }[]): void => {
    handles.push(
      ctx.ui.openMenu(anchor, { label, preferredSide: "down", items }, { signal: scoped() }),
    );
  };

  const section = (title: string, aside?: string): HTMLElement => {
    const wrapper = el(document, "section", "rm-sec");
    const head = el(document, "div", "rm-sec-title");
    head.append(el(document, "span", undefined, title));
    if (aside) head.append(el(document, "span", undefined, aside));
    wrapper.append(head);
    body.append(wrapper);
    return wrapper;
  };

  const item = (icon: string | null, title: string | HTMLElement, sub?: string): HTMLElement => {
    const row = el(document, "div", "rm-li");
    const iconHost = el(document, "span", icon ? "rm-li-icon" : "rm-li-dash");
    if (icon) setIcon(iconHost, icon);
    else iconHost.textContent = "—";
    const text = el(document, "div", "rm-li-text");
    if (typeof title === "string") text.append(el(document, "div", undefined, title));
    else text.append(title);
    if (sub) text.append(el(document, "div", "rm-li-sub", sub));
    row.append(iconHost, text);
    return row;
  };

  /** Evidence from the Knowledge Graph. Each choice goes through the same status path as the status menu. */
  const evidenceSection = (node: PathNode, evidence: NodeEvidence): void => {
    const wrapper = section(t("evi.title"));
    const level = t(`evi.${evidence.level}` as MessageKey);
    const first = shortDate(evidence.firstAt, localeTag());
    const last = shortDate(evidence.lastAt, localeTag());
    wrapper.append(el(document, "p", "rm-why", t("evi.summary", { level, n: evidence.sessionCount, first, last })));
    wrapper.append(el(document, "p", "rm-muted", t("evi.note")));
    // Seen is evidence text only: the action buttons are offered for practiced and mastered alone.
    if (evidence.level === "seen") return;

    const choices = el(document, "div", "rm-chips");
    const offer = (target: EvidenceSuggestion, label: string): void => {
      const suggested = evidence.suggestion === target;
      if (suggested) choices.append(el(document, "span", "rm-tag", t("evi.suggested")));
      const choice = button(document, label, () => void options.updateNode({ progression: target }), scoped(), {
        variant: suggested ? "primary" : "outline",
      });
      choice.disabled = node.progression === target;
      choices.append(choice);
    };
    offer("consolidated", t("evi.markConsolidated"));
    offer("skipped", t("evi.skip"));
    wrapper.append(choices);
  };

  /**
   * Flashcard seed: lists the learner's own graph propositions for the node. The Flashcards plugin's review lives
   * in its own view, which this plugin cannot open or detect, so the dialog says where to find it.
   */
  const showPropositions = async (node: PathNode): Promise<void> => {
    if (!options.nodePropositions) return;
    let found: readonly NodeProposition[] | null;
    try {
      found = await options.nodePropositions(node);
    } catch {
      found = null;
    }
    if (disposed || signal.aborted) return;
    let dialog: PluginWidgetHandle<PluginDialogProps> | null = null;
    dialog = ctx.ui.openDialog(
      {
        title: t("flash.title"),
        content: (content, contentSignal) => {
          content.append(el(document, "h2", "rm-insp-title", t("flash.title")));
          content.append(el(document, "p", "rm-why", t("flash.reviewNote")));
          if (found === null) {
            content.append(el(document, "p", "rm-muted", t("flash.unavailable")));
          } else if (found.length === 0) {
            content.append(el(document, "p", "rm-muted", t("flash.none")));
          } else {
            const list = el(document, "div", "rm-list");
            for (const proposition of found) {
              list.append(item(null, proposition.name, proposition.statement));
            }
            content.append(list);
          }
          const actions = el(document, "div", "rm-chips");
          actions.append(button(document, t("flash.close"), () => dialog?.dispose(), contentSignal, { variant: "outline" }));
          content.append(actions);
        },
      },
      { signal: scoped() },
    );
    handles.push(dialog);
  };

  const renderSelected = (path: LearningPath, node: PathNode): void => {
    root.dataset.nodeId = node.id;
    body.append(el(document, "h2", "rm-insp-title", node.title));

    const meta = el(document, "div", "rm-insp-meta");
    const status = el(document, "button", `rm-status rm-status-${node.progression}`);
    status.type = "button";
    status.setAttribute("aria-label", t("insp.type"));
    const statusIconHost = el(document, "span", "rm-status-icon");
    setIcon(statusIconHost, statusIcon(node.progression));
    const chevron = el(document, "span", "rm-status-chevron");
    setIcon(chevron, ICONS.chevronDown);
    status.append(statusIconHost, el(document, "span", undefined, t(`status.${node.progression}` as MessageKey)), chevron);
    status.addEventListener("click", () => {
      menu(status, t("insp.type"), PROGRESSION_STATES.map((state) => ({
        key: state,
        label: t(`status.${state}` as MessageKey),
        onSelect: () => {
          if (state !== node.progression) void options.updateNode({ progression: state });
        },
      })));
    }, { signal: scoped() });
    meta.append(status, el(document, "span", "rm-tag", t(`type.${node.type}` as MessageKey)));
    meta.append(
      el(
        document,
        "span",
        "rm-tag",
        node.alternativeGroup ? t("mark.alternative") : node.optional ? t("mark.optional") : t("mark.recommended"),
      ),
    );
    if (node.reviewMark) meta.append(el(document, "span", "rm-tag", t("mark.shortReview")));
    body.append(meta);
    body.append(el(document, "p", "rm-insp-goal", node.goal));
    const evidence = nodeEvidence(node, options.knowledgeMastery?.() ?? []);
    if (evidence) evidenceSection(node, evidence);
    body.append(pivotContainer);
    pivotBanner.render(path, node);

    if (node.outcomes?.length) {
      const outcomes = section(t("insp.outcomes"));
      for (const outcome of node.outcomes) outcomes.append(item(null, outcome));
    }

    const source = section(t("insp.source"));
    source.append(item(ICONS.book, formatAnchor(node.sourceAnchor), node.lightPreReading ? t("insp.preReading", { text: node.lightPreReading }) : undefined));

    if (node.codeRepo) {
      const repo = section(t("insp.codeRepo"));
      repo.append(item(null, node.codeRepo.location));
    }

    if (node.resources?.length) {
      const resources = section(t("insp.resources"));
      for (const resource of node.resources) {
        const kind = t(`res.${resource.kind}` as MessageKey);
        const sub = [
          resource.essential ? t("insp.essential") : "",
          kind,
          resource.free ? t("insp.free") : "",
          resource.checked ? t("insp.checked") : "",
          resource.use ?? "",
        ].filter(Boolean).join(" · ");
        let title: string | HTMLElement = resource.title;
        if (resource.url) {
          const link = el(document, "a", "rm-link", resource.title);
          link.href = resource.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          title = link;
        }
        resources.append(item(RESOURCE_ICON[resource.kind], title, sub));
      }
    }

    const related = node.interleavesNodeIds.map((id) => findNode(path, id)).filter((entry): entry is PathNode => entry !== null);
    if (related.length > 0) {
      const relatedSection = section(t("insp.related"));
      const row = el(document, "div", "rm-chips");
      for (const prior of related) {
        row.append(button(document, prior.title, () => options.selectNode(prior.id), scoped(), { variant: "ghost", className: "rm-chip" }));
      }
      relatedSection.append(row);
    }

    const sessions = section(t("insp.sessions"));
    const sessionsTitle = sessions.firstElementChild as HTMLElement;
    sessionsTitle.append(
      button(document, t("insp.linkExisting"), () => void options.linkExistingSession(), scoped(), {
        variant: "link",
        icon: ICONS.link,
        title: t("action.linkExisting"),
      }),
    );
    if (node.childSessions.length === 0) {
      sessions.append(el(document, "p", "rm-muted", t("insp.noSessions")));
    } else {
      for (const chat of [...node.childSessions].reverse()) {
        const status = options.chatStatus?.get(chat.chatId);
        const exists = status?.exists ?? true;
        const row = el(document, "div", `rm-session${exists ? "" : " rm-session-missing"}`);
        const open = el(document, "button", "rm-session-open");
        open.type = "button";
        open.disabled = !exists;
        const icon = el(document, "span", "rm-li-icon");
        setIcon(icon, chat.kind === "teaching" ? ICONS.chat : ICONS.exercises);
        const text = el(document, "div", "rm-li-text");
        const kind = chat.kind === "teaching" ? t("insp.lessonLabel") : t("insp.practiceLabel");
        text.append(el(document, "div", undefined, `${kind} · ${status?.title ?? chat.label}`));
        const parts = [shortDate(status?.createdAt ?? chat.createdAt, localeTag())];
        if (!exists) parts.push(t("insp.missing"));
        else {
          const minutes = Math.round((status?.focusedMs ?? 0) / 60000);
          if (minutes > 0) parts.push(t("insp.minutes", { n: minutes }));
          if (status?.answered) parts.push(t("insp.correct", { ok: status.correct ?? 0, n: status.answered }));
        }
        text.append(el(document, "div", "rm-li-sub", parts.filter(Boolean).join(" · ")));
        open.append(icon, text);
        open.addEventListener("click", () => {
          if (exists) options.openSession(chat.chatId);
        }, { signal: scoped() });
        const more = el(document, "button", "rm-icon-btn");
        more.type = "button";
        more.setAttribute("aria-label", t("action.more"));
        setIcon(more, ICONS.more);
        more.addEventListener("click", () => {
          menu(more, t("action.more"), [
            ...(exists ? [{ key: "open", label: t("action.open"), onSelect: () => options.openSession(chat.chatId) }] : []),
            { key: "unlink", label: t("action.unlink"), onSelect: () => void options.unlinkSession(chat.chatId) },
          ]);
        }, { signal: scoped() });
        row.append(open, more);
        sessions.append(row);
      }
    }

    const artifactSection = section(t("insp.artifact"));
    const effective = effectiveArtifact(path, node);
    const entry = artifactCatalogEntry(effective);
    const select = el(document, "select", "rm-select");
    select.setAttribute("aria-label", t("insp.artifact"));
    const inherited = el(
      document,
      "option",
      undefined,
      t("insp.artifactDefault", { label: artifactName(path.artifactDefault ?? recommendedArtifactsFor(node.type)[0] ?? "none") }),
    );
    inherited.value = "";
    select.append(inherited);
    const chosen = node.artifactConfig ? effective : "";
    for (const option of ARTIFACT_CATALOG) {
      const choice = el(document, "option", undefined, artifactName(option.type));
      choice.value = option.type;
      if (option.type === chosen) choice.selected = true;
      select.append(choice);
    }
    if (chosen === "") inherited.selected = true;
    select.addEventListener("change", () => {
      void options.updateNode({ artifactType: select.value === "" ? null : (select.value as ArtifactType) });
    }, { signal: scoped() });
    artifactSection.append(select);
    if (node.artifactConfig?.instructions) artifactSection.append(item(ICONS.article, node.artifactConfig.instructions));
    artifactSection.append(el(document, "p", "rm-why", t("insp.why", { text: t(`artWhy.${entry.type}` as MessageKey) })));
    if (effective === "retrieval_cue" && options.nodePropositions) {
      artifactSection.append(
        button(document, t("flash.open"), () => void showPropositions(node), scoped(), { variant: "outline" }),
      );
    }

    footer.append(
      button(document, t("action.lesson"), () => void options.startSession("teaching"), scoped(), { variant: "primary" }),
      button(document, t("action.practice"), () => void options.startSession("practice"), scoped(), { variant: "outline" }),
    );
    if (options.findResources) {
      footer.append(
        button(document, t("action.findResources"), () => void options.findResources?.(node), scoped(), {
          variant: "outline",
          className: "rm-push",
        }),
      );
    }
    const hintKey = options.showPatternHints?.() === false ? null : nodePatternHintKey(node.type);
    if (hintKey) footer.append(el(document, "p", "rm-insp-hint", t(hintKey)));
  };

  return {
    render(path, node) {
      if (disposed || signal.aborted) return;
      clear();
      root.removeAttribute("data-node-id");
      footer.hidden = !path || !node;
      if (!path || !node) {
        body.append(el(document, "p", "rm-muted rm-insp-empty", t("insp.empty")));
        pivotBanner.render(null, null);
        errorLedger.render(null, null);
        return;
      }
      renderSelected(path, node);
      errorLedger.render(path, node);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      pivotBanner.dispose();
      errorLedger.dispose();
      root.remove();
    },
  };
}
