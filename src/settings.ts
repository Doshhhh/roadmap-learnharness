/** Dedicated Roadmap Settings page.
 *
 * Three sections on one lazily mounted page:
 * - artifact defaults per node type, each showing the framework's justification
 *   for every option and the recommendation for that node type;
 * - the Architect model preference: follow the host strong slot, or override
 *   with the host model/thinking pickers;
 * - path management. Deletion removes only this plugin's path record and any
 *   converted source files no surviving path uses. Native LearnHarness chats and
 *   Knowledge Graph records are host-owned and are never touched.
 *
 * The host does not persist plugin settings for us. Every accepted change is
 * written through `settings.save`, and the saved record is fed back into the
 * controlled widgets; failures are shown inline.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  PluginDialogProps,
  PluginFrontendContext,
  PluginModelValue,
  PluginSettingsRow,
  PluginSettingsSchema,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import {
  ARTIFACT_CATALOG,
  NODE_TYPES,
  artifactCatalogEntry,
  defaultArtifactFor,
  recommendedArtifactsFor,
} from "./domain.ts";
import type {
  ArchitectPreferences,
  ArtifactType,
  NodeType,
  PluginSettings,
  ThinkingLevelName,
} from "./domain.ts";
import { EVENT_PATHS_CHANGED, EVENT_SETTINGS_CHANGED } from "./topics.ts";
import { locale, resolveLocale, setLocale, t } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";
import { artifactName } from "./view/node-inspector.ts";
import { mountResearchSettings } from "./research-settings.ts";
import { DEFAULT_DISPLAY, LANGUAGE_PREFERENCES, VIEW_MODES } from "./domain.ts";
import type { DisplaySettings, LanguagePreference, ViewMode } from "./domain.ts";

interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
}

interface SettingsResult {
  readonly settings: PluginSettings;
  /** The new Architect model waits for a running Architect conversation to finish. */
  readonly modelPending?: boolean;
}

interface PathsResult {
  readonly paths: readonly PathSummary[];
}

interface DeleteResult {
  readonly deleted: boolean;
  readonly removedSources: readonly string[];
  readonly retainedSources: readonly string[];
  readonly preservedChats: number;
  readonly knowledgeGraphRecordsChanged: number;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorMessage(problem: unknown): string {
  if (problem instanceof Error && problem.message.trim()) return problem.message;
  return typeof problem === "string" && problem.trim() ? problem : "Unexpected error.";
}

/** A section wrapper with a heading and an optional intro paragraph. */
function section(document: Document, container: HTMLElement, title: string, intro?: string): HTMLElement {
  const wrapper = element(document, "section", "lp-settings-section");
  wrapper.append(element(document, "h2", "lp-settings-heading", title));
  if (intro !== undefined) wrapper.append(element(document, "p", "lp-muted", intro));
  container.append(wrapper);
  return wrapper;
}

export function mountSettingsPage(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  /** Called when the saved interface language differs from the active one. */
  onLocaleChange?: () => void,
): () => void {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-settings");
  container.append(root);

  root.append(element(document, "h1", "lp-settings-title", t("s.title")));
  root.append(
    element(
      document,
      "p",
      "lp-muted",
      t("s.intro"),
    ),
  );
  const status = element(document, "p", "lp-settings-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  root.append(status);

  const displaySection = section(document, root, t("s.display"), t("s.displayIntro"));
  const displayRowsHost = element(document, "div", "lp-settings-rows");
  displaySection.append(displayRowsHost);
  let displayRows: PluginWidgetHandle<PluginSettingsSchema> | null = null;

  const artifactsSection = section(
    document,
    root,
    t("s.artifacts"),
    t("s.artifactsIntro"),
  );
  const artifactRowsHost = element(document, "div", "lp-settings-rows");
  artifactsSection.append(artifactRowsHost);

  const catalogDetails = element(document, "details", "lp-artifact-catalog");
  catalogDetails.open = true;
  catalogDetails.append(
    element(document, "summary", undefined, t("s.catalog")),
  );
  for (const entry of ARTIFACT_CATALOG) {
    const card = element(document, "article", "lp-artifact-option");
    card.dataset.artifactType = entry.type;
    card.append(element(document, "h3", "lp-artifact-option-title", artifactName(entry.type)));
    card.append(element(document, "p", "lp-artifact-justification", t(`artWhy.${entry.type}` as MessageKey)));
    card.append(
      element(
        document,
        "p",
        "lp-muted",
        t("s.bestFor", { types: entry.bestFor.map((type) => t(`type.${type}` as MessageKey)).join(", ") }),
      ),
    );
    catalogDetails.append(card);
  }
  artifactsSection.append(catalogDetails);

  const researchSection = section(document, root, t("s.research"), t("s.researchIntro"));
  const researchHost = element(document, "div", "rm-research-settings");
  researchSection.append(researchHost);

  const architectSection = section(
    document,
    root,
    t("s.architect"),
    t("s.architectIntro"),
  );
  const architectHost = element(document, "div", "lp-architect-settings");
  architectSection.append(architectHost);

  const pathsSection = section(
    document,
    root,
    t("s.paths"),
    t("s.pathsIntro"),
  );
  const pathsHost = element(document, "div", "lp-settings-paths");
  pathsSection.append(pathsHost);

  let settings: PluginSettings = { artifactDefaults: {} };
  /** Unsaved "override is on but no model chosen yet" draft; never persisted. */
  let overrideDraft: ArchitectPreferences | null = null;
  let summaries: readonly PathSummary[] = [];
  let artifactRows: PluginWidgetHandle<PluginSettingsSchema> | null = null;
  let architectHandles: PluginWidgetHandle<unknown>[] = [];
  let pathHandles: PluginWidgetHandle<unknown>[] = [];
  const dialogs: PluginWidgetHandle<PluginDialogProps>[] = [];
  let loadToken = 0;
  let disposed = false;

  const researchPanel = mountResearchSettings(ctx, researchHost, {
    signal,
    settings: () => settings,
    save: (next) => saveSettings(next),
    onError: (message) => setStatus(message, "error"),
  });

  const live = (token: number): boolean => !disposed && !signal.aborted && token === loadToken;

  function setStatus(message: string | null, kind: "info" | "error" = "info"): void {
    if (disposed || signal.aborted) return;
    status.textContent = message ?? "";
    status.hidden = message === null;
    delete status.dataset.state;
    if (message !== null) status.dataset.state = kind;
  }

  function clearArchitect(): void {
    for (const handle of architectHandles.reverse()) handle.dispose();
    architectHandles = [];
    architectHost.replaceChildren();
  }

  function clearPaths(): void {
    for (const handle of pathHandles.reverse()) handle.dispose();
    pathHandles = [];
    pathsHost.replaceChildren();
  }

  const chooseArtifact = async (type: NodeType, value: string): Promise<void> => {
    const artifactDefaults = { ...settings.artifactDefaults };
    if (value === "") delete artifactDefaults[type];
    else artifactDefaults[type] = value as ArtifactType;
    await saveSettings({ ...settings, artifactDefaults });
  };

  function artifactRowsFor(state: PluginSettings): PluginSettingsRow[] {
    return NODE_TYPES.map((type) => {
      const chosen = state.artifactDefaults[type];
      const fallback = defaultArtifactFor(type);
      const current = artifactCatalogEntry(chosen ?? fallback);
      const recommended = recommendedArtifactsFor(type)
        .map((artifact) => artifactName(artifact))
        .join(", ");
      return {
        key: `artifact-${type}`,
        type: "dropdown" as const,
        label: t(`type.${type}` as MessageKey),
        description: t("s.recommended", { list: recommended, why: t(`artWhy.${current.type}` as MessageKey) }),
        value: chosen ?? "",
        options: [
          {
            value: "",
            label: t("s.frameworkDefault", { label: artifactName(fallback) }),
          },
          ...ARTIFACT_CATALOG.map((entry) => ({ value: entry.type, label: artifactName(entry.type) })),
        ],
        onChange: (value: string) => chooseArtifact(type, value),
      };
    });
  }

  function currentDisplay(): DisplaySettings {
    return settings.display ?? DEFAULT_DISPLAY;
  }

  function languageOptions(): { value: string; label: string }[] {
    return LANGUAGE_PREFERENCES.map((value) => ({ value, label: t(`s.${value}` as MessageKey) }));
  }

  function renderDisplayRows(): void {
    if (disposed || signal.aborted) return;
    const display = currentDisplay();
    const rows: PluginSettingsRow[] = [
      {
        key: "display-language",
        type: "dropdown" as const,
        label: t("s.language"),
        description: t("s.languageDesc"),
        value: display.language,
        options: languageOptions(),
        onChange: (value: string) =>
          void saveSettings({ ...settings, display: { ...currentDisplay(), language: value as LanguagePreference } }),
      },
      {
        key: "content-language",
        type: "dropdown" as const,
        label: t("s.contentLanguage"),
        description: t("s.contentLanguageDesc"),
        value: settings.contentLanguage ?? "auto",
        options: languageOptions(),
        onChange: (value: string) => void saveSettings({ ...settings, contentLanguage: value as LanguagePreference }),
      },
      {
        key: "display-view",
        type: "dropdown" as const,
        label: t("s.defaultView"),
        description: t("s.defaultViewDesc"),
        value: display.defaultView,
        options: VIEW_MODES.map((value) => ({ value, label: t(value === "graph" ? "view.graph" : "view.tree") })),
        onChange: (value: string) =>
          void saveSettings({ ...settings, display: { ...currentDisplay(), defaultView: value as ViewMode } }),
      },
      {
        key: "propose-roadmaps",
        type: "toggle" as const,
        label: t("s.propose"),
        description: t("s.proposeDesc"),
        value: settings.proposeRoadmaps !== false,
        onChange: (value: boolean) => void saveSettings({ ...settings, proposeRoadmaps: value }),
      },
      {
        key: "display-optional",
        type: "toggle" as const,
        label: t("s.showOptional"),
        description: t("s.showOptionalDesc"),
        value: display.showOptional,
        onChange: (value: boolean) => void saveSettings({ ...settings, display: { ...currentDisplay(), showOptional: value } }),
      },
      {
        key: "display-pattern-hints",
        type: "toggle" as const,
        label: t("s.patternHints"),
        description: t("s.patternHintsDesc"),
        value: display.patternHints,
        onChange: (value: boolean) => void saveSettings({ ...settings, display: { ...currentDisplay(), patternHints: value } }),
      },
    ];
    if (displayRows) displayRows.update({ rows });
    else displayRows = ctx.ui.mountSettingsRows(displayRowsHost, { rows }, { signal });
  }

  /** True when the page had to be rebuilt in another language. */
  function followLanguage(): boolean {
    const wanted = resolveLocale(settings.display?.language);
    if (wanted === locale() || !onLocaleChange) return false;
    setLocale(wanted);
    onLocaleChange();
    return true;
  }

  function renderArtifactRows(): void {
    if (disposed || signal.aborted) return;
    const rows = artifactRowsFor(settings);
    if (artifactRows) artifactRows.update({ rows });
    else artifactRows = ctx.ui.mountSettingsRows(artifactRowsHost, { rows }, { signal });
  }

  function preferences(): ArchitectPreferences {
    return overrideDraft ?? settings.architect ?? { followHostSlot: true };
  }

  async function setFollowHost(value: boolean): Promise<void> {
    const current = preferences();
    if (value) {
      overrideDraft = null;
      await saveSettings({ ...settings, architect: { followHostSlot: true } });
      return;
    }
    // Turning the override on exposes the pickers. The draft is deliberately not
    // saved: an invalid half-configured record must never reach the store.
    overrideDraft = {
      followHostSlot: false,
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: current.thinkingLevel }),
    };
    renderArchitect();
    setStatus(
      current.model === undefined
        ? t("s.chooseModel")
        : t("s.overrideReady"),
    );
  }

  async function setArchitectModel(value: PluginModelValue): Promise<void> {
    overrideDraft = null;
    await saveSettings({
      ...settings,
      architect: {
        followHostSlot: false,
        model: { provider: value.provider, id: value.id },
      },
    });
  }

  async function setThinking(value: ThinkingLevel): Promise<void> {
    const current = preferences();
    if (current.model === undefined) return;
    overrideDraft = null;
    await saveSettings({
      ...settings,
      architect: {
        followHostSlot: false,
        model: current.model,
        thinkingLevel: value as ThinkingLevelName,
      },
    });
  }

  function renderArchitect(): void {
    if (disposed || signal.aborted) return;
    clearArchitect();
    const current = preferences();

    const rowsHost = element(document, "div", "lp-settings-rows");
    architectHost.append(rowsHost);
    architectHandles.push(
      ctx.ui.mountSettingsRows(
        rowsHost,
        {
          rows: [
            {
              key: "architect-follow-host",
              type: "toggle" as const,
              label: t("s.followHost"),
              description:
                t("s.followHostDesc"),
              value: current.followHostSlot,
              onChange: (value: boolean) => setFollowHost(value),
            },
          ],
        },
        { signal },
      ),
    );

    if (current.followHostSlot) {
      architectHost.append(
        element(
          document,
          "p",
          "lp-muted",
          t("s.followingHost"),
        ),
      );
      return;
    }

    const modelHost = element(document, "div", "lp-model-picker-host");
    architectHost.append(
      element(document, "h3", "lp-settings-subheading", t("s.override")),
      modelHost,
    );
    const modelValue =
      current.model === undefined
        ? undefined
        : { provider: current.model.provider, id: current.model.id };
    architectHandles.push(
      ctx.ui.mountModelPicker(
        modelHost,
        {
          value: modelValue,
          onChange: (value: PluginModelValue) => setArchitectModel(value),
        },
        { signal },
      ),
    );

    const thinkingHost = element(document, "div", "lp-thinking-picker-host");
    architectHost.append(
      element(document, "h3", "lp-settings-subheading", t("s.thinking")),
      thinkingHost,
    );
    architectHandles.push(
      ctx.ui.mountThinkingPicker(
        thinkingHost,
        {
          model: modelValue,
          value: current.thinkingLevel,
          disabled: modelValue === undefined,
          onChange: (value: ThinkingLevel) => setThinking(value),
        },
        { signal },
      ),
    );
  }

  async function deletePath(summary: PathSummary): Promise<void> {
    try {
      const result = await ctx.call<DeleteResult>("paths.delete", { pathId: summary.id });
      if (disposed || signal.aborted) return;
      let message: string;
      if (!result.deleted) {
        message = t("s.alreadyGone", { title: summary.title });
      } else {
        const sources =
          result.removedSources.length === 0
            ? t("s.noOrphans")
            : t("s.removedSources", { n: result.removedSources.length }) +
              (result.retainedSources.length === 0 ? "" : t("s.retainedSources", { n: result.retainedSources.length }));
        message = t("s.deleted", { title: summary.title, sources, chats: result.preservedChats });
      }
      await load();
      setStatus(message, "info");
    } catch (problem) {
      if (disposed || signal.aborted) return;
      setStatus(t("s.deleteFailed", { title: summary.title, message: errorMessage(problem) }), "error");
    }
  }

  function openDeleteDialog(summary: PathSummary): void {
    if (disposed || signal.aborted) return;
    let dialog: PluginWidgetHandle<PluginDialogProps> | null = null;
    dialog = ctx.ui.openDialog(
      {
        title: t("s.deleteTitle", { title: summary.title }),
        content: (content, contentSignal) => {
          content.append(element(document, "h2", "lp-dialog-title", summary.title));
          content.append(
            element(
              document,
              "p",
              "lp-dialog-text",
              t("s.deleteText", { modules: summary.moduleCount, nodes: summary.nodeCount }),
            ),
          );
          content.append(
            element(
              document,
              "p",
              "lp-dialog-text lp-dialog-safe",
              t("s.deleteSafe"),
            ),
          );
          const actions = element(document, "div", "lp-dialog-actions");
          content.append(actions);

          const keepHost = element(document, "span", "lp-button-host");
          actions.append(keepHost);
          ctx.ui.mountButton(
            keepHost,
            {
              label: t("s.keep"),
              variant: "outline",
              size: "sm",
              onClick: () => dialog?.dispose(),
            },
            { signal: contentSignal },
          );

          const deleteHost = element(document, "span", "lp-button-host");
          actions.append(deleteHost);
          ctx.ui.mountButton(
            deleteHost,
            {
              label: t("s.confirmDelete"),
              variant: "destructive",
              size: "sm",
              onClick: () => {
                dialog?.dispose();
                void deletePath(summary);
              },
            },
            { signal: contentSignal },
          );
        },
      },
      { signal },
    );
    dialogs.push(dialog);
  }

  function renderPaths(): void {
    if (disposed || signal.aborted) return;
    clearPaths();
    if (summaries.length === 0) {
      pathsHost.append(
        element(
          document,
          "p",
          "lp-muted",
          t("s.noPaths"),
        ),
      );
      return;
    }
    const list = element(document, "ul", "lp-settings-path-list");
    for (const summary of summaries) {
      const item = element(document, "li", "lp-settings-path-row");
      item.dataset.pathId = summary.id;
      const text = element(document, "span", "lp-settings-path-text");
      text.append(element(document, "strong", undefined, summary.title));
      text.append(
        element(
          document,
          "span",
          "lp-muted",
          t("s.pathMeta", { modules: summary.moduleCount, nodes: summary.nodeCount }),
        ),
      );
      item.append(text);
      const actions = element(document, "span", "lp-settings-path-actions");
      item.append(actions);
      const host = element(document, "span", "lp-button-host");
      actions.append(host);
      pathHandles.push(
        ctx.ui.mountButton(
          host,
          {
            label: t("s.delete"),
            variant: "ghost",
            size: "xs",
            onClick: () => openDeleteDialog(summary),
          },
          { signal },
        ),
      );
      list.append(item);
    }
    pathsHost.append(list);
  }

  async function saveSettings(next: PluginSettings): Promise<boolean> {
    if (disposed || signal.aborted) return false;
    setStatus(t("s.saving"));
    try {
      const result = await ctx.call<SettingsResult>("settings.save", next);
      if (disposed || signal.aborted) return false;
      settings = result.settings;
      showSaved(result.settings, result.modelPending === true);
      return true;
    } catch (problem) {
      if (disposed || signal.aborted) return false;
      setStatus(t("s.saveFailed", { message: errorMessage(problem) }), "error");
      // Restore the controlled widgets to the last accepted record.
      renderDisplayRows();
      renderArtifactRows();
      renderArchitect();
      return false;
    }
  }

  function showSaved(saved: PluginSettings, modelPending = false): void {
    settings = saved;
    setStatus(
      modelPending
        ? t("s.savedPending")
        : t("s.saved"),
    );
    if (followLanguage()) return;
    renderDisplayRows();
    renderArtifactRows();
    renderArchitect();
  }

  async function load(): Promise<void> {
    if (disposed || signal.aborted) return;
    const token = ++loadToken;
    try {
      const [settingsResult, pathsResult] = await Promise.all([
        ctx.call<SettingsResult>("settings.get"),
        ctx.call<PathsResult>("paths.list"),
      ]);
      if (!live(token)) return;
      settings = settingsResult.settings;
      overrideDraft = null;
      summaries = [...(pathsResult.paths ?? [])];
      if (followLanguage()) return;
      renderDisplayRows();
      renderArtifactRows();
      renderArchitect();
      renderPaths();
      void researchPanel.render();
      setStatus(null);
    } catch (problem) {
      if (!live(token)) return;
      setStatus(t("s.loadFailed", { message: errorMessage(problem) }), "error");
    }
  }

  const offNotification = ctx.onNotification((event) => {
    if (disposed || signal.aborted) return;
    if (event.topic === EVENT_SETTINGS_CHANGED || event.topic === EVENT_PATHS_CHANGED) {
      void load();
    }
  });
  const offResync = ctx.onResync(() => {
    if (disposed || signal.aborted) return;
    void load();
  });

  void load();

  return () => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    offNotification();
    offResync();
    for (const handle of dialogs.reverse()) handle.dispose();
    dialogs.length = 0;
    clearArchitect();
    clearPaths();
    artifactRows?.dispose();
    artifactRows = null;
    displayRows?.dispose();
    displayRows = null;
    researchPanel.dispose();
    root.remove();
  };
}
