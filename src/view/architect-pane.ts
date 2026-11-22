/** Architect Chat surface for the Path Hub.
 *
 * The pane owns conversation state, not persistence: every command goes through
 * the plugin backend (`architect.*`, `sources.save`) and the view feeds
 * authoritative snapshots back in after notifications or `onResync`.
 *
 * Host controls used here:
 * - `ctx.ui.mountStandardComposer` for the model/thinking/composer/dictation set;
 * - `ctx.ui.mountMarkdown` for every assistant turn;
 * - `ctx.ui.mountButton` for the PDF/UTF-8 upload trigger.
 * All handles are scoped to the per-mount `AbortSignal` and disposed on unmount.
 */
import { locale, t } from "../i18n.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ArchitectProgress } from "../topics.ts";
import type {
  PluginAgentSnapshot,
  PluginComposerProps,
  PluginDialogProps,
  PluginFrontendContext,
  PluginModelValue,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import { createBrowserSessionHost } from "../native-session-host.ts";
import type { NativeSessionHost } from "../native-session-host.ts";

interface PaneResearchStatus {
  readonly effective: { session: boolean };
  readonly tools: readonly string[];
}

const DEEP_RESEARCH_PREFIX =
  "[Deep research is ON for this message. Research thoroughly before answering: many search angles, read the tables of contents, " +
  "syllabi and pages you rely on, canonical and deeper sources, and use deep_research if you have it. Then build or refine the path.]\n\n";

const ACCEPTED = /\.(pdf|md|markdown|txt|text)$/i;

export interface ArchitectPane {
  readonly element: HTMLElement;
  /** Open a fresh draft so the learner can choose a model before the first send. */
  startNew(): void;
  /** Re-read one conversation snapshot after a notification or resync. */
  load(conversationId: string): Promise<void>;
  /** Apply a change notification: when the committed history is unchanged
   * (`messageCount` matches), read only live progress; otherwise reload. */
  refresh(conversationId: string, messageCount?: number): Promise<void>;
  /** Adopt an already authoritative snapshot (from `architect.create/send/get`). */
  setConversation(snapshot: PluginAgentSnapshot | null): void;
  /** Open a conversation if needed, then send a plugin-authored prompt.
   * `learnerGraph` asks the backend to attach the learner's graph brief to this message. */
  discuss(text: string, options?: { learnerGraph?: boolean }): Promise<void>;
  conversationId(): string | null;
  /** Whether the user has explicitly opened a fresh unsent draft. */
  isNewDraft(): boolean;
  /** Convert and store one uploaded PDF/UTF-8 document. */
  uploadFile(file: File): Promise<void>;
  dispose(): void;
}

interface TextPart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly name?: unknown;
}

function requestId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === "string" && error.trim() ? error : t("e.unexpected");
}

function messageText(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user" && record.role !== "assistant") return null;
  const content = record.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is TextPart => part !== null && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  return text || null;
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

export function createArchitectPane(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
): ArchitectPane {
  const document = container.ownerDocument;
  const root = element(document, "section", "lp-architect");
  root.setAttribute("aria-label", t("a.title"));

  const headingRow = element(document, "div", "lp-pane-heading");
  headingRow.append(element(document, "h2", "lp-pane-title", t("a.title")));
  const status = element(document, "p", "lp-architect-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  headingRow.append(status);
  root.append(headingRow);

  const log = element(document, "div", "lp-chat-log");
  log.setAttribute("aria-label", t("a.log"));
  // Committed history is re-rendered only when it changes; the streamed partial
  // lives in its own section so progress ticks never remount the whole log.
  const history = element(document, "div", "lp-chat-history");
  const live = element(document, "div", "lp-chat-live");
  const emptyChat = element(document, "p", "lp-empty-chat",
    t("a.empty"));
  log.append(history, live, emptyChat);
  root.append(log);

  // One composer card: attached books, the text field, then a quiet tool bar.
  const card = element(document, "div", "rm-composer");
  const sourcesRow = element(document, "div", "rm-composer-sources");
  const uploadStatus = element(document, "p", "lp-upload-status");
  uploadStatus.setAttribute("role", "status");
  uploadStatus.setAttribute("aria-live", "polite");
  const fileInput = element(document, "input", "lp-file-input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".pdf,.md,.markdown,.txt,.text,application/pdf,text/plain,text/markdown";
  fileInput.hidden = true;
  fileInput.setAttribute("aria-label", t("a.uploadAria"));
  const composerHost = element(document, "div", "lp-composer-host");
  const bar = element(document, "div", "rm-composer-bar");
  const attach = element(document, "button", "rm-chip-button");
  attach.type = "button";
  attach.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';
  attach.append(element(document, "span", undefined, t("a.attach")));
  attach.title = t("a.attachHint");
  const deep = element(document, "button", "rm-chip-button rm-deep");
  deep.type = "button";
  deep.setAttribute("aria-pressed", "false");
  deep.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>';
  deep.append(element(document, "span", undefined, t("a.deep")));
  deep.title = t("a.deepHint");
  const researchSession = element(document, "button", "rm-chip-button");
  researchSession.type = "button";
  researchSession.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg>';
  researchSession.append(element(document, "span", undefined, t("a.researchSession")));
  researchSession.title = t("a.researchSessionHint");
  const spacer = element(document, "span", "rm-composer-spacer");
  const modelHint = element(document, "span", "rm-model-hint");
  const dictationHost = element(document, "span", "rm-dictation-host");
  bar.append(attach, deep, researchSession, spacer, dictationHost);
  sourcesRow.append(uploadStatus, fileInput);
  card.append(sourcesRow, composerHost, bar);
  const dropHint = element(document, "div", "rm-drop-hint", t("a.dropHint"));
  dropHint.hidden = true;
  const logLine = element(document, "p", "lp-architect-log");
  root.append(card, modelHint, logLine, dropHint);
  container.append(root);
  // The Architect's timing log lives in the plugin data folder; show where to find it.
  ctx.call("architect.logPath", {}).then((result) => {
    const path = (result as { path?: unknown } | null)?.path;
    if (!signal.aborted && typeof path === "string") logLine.textContent = t("a.logPath", { path });
  }).catch(() => undefined);

  let conversation: PluginAgentSnapshot | null = null;
  let draft = "";
  let model: PluginModelValue | undefined;
  let thinking: ThinkingLevel | undefined;
  let sending = false;
  let creating = false;
  let uploading = false;
  let error: string | null = null;
  let historyHandles: PluginWidgetHandle<unknown>[] = [];
  let liveHandles: PluginWidgetHandle<unknown>[] = [];
  let renderedHistoryKey: string | null = null;
  let historyTurns = 0;
  let disposed = false;
  let loadVersion = 0;
  let newDraft = false;
  let deepResearch = false;
  let research: PaneResearchStatus | null = null;
  const sessionHost: NativeSessionHost = createBrowserSessionHost();
  const uploadQueue: File[] = [];

  attach.addEventListener("click", () => {
    if (!signal.aborted && !disposed) fileInput.click();
  }, { signal });

  const busy = (): boolean => creating || sending || conversation?.status === "running";

  const composerProps = (): PluginComposerProps => ({
    value: draft,
    onChange: (value) => {
      if (signal.aborted || disposed) return;
      draft = value;
      updateComposer();
    },
    onSend: () => {
      void send();
    },
    onStop: () => {
      void stop();
    },
    busy: busy(),
    canSend: draft.trim().length > 0,
    placeholder: conversation ? t("a.phRefine") : t("a.phNew"),
  });

  let composerHandle: PluginWidgetHandle<PluginComposerProps> | null = null;
  let dictationHandle: PluginWidgetHandle<{ disabled?: boolean; onTranscript: (text: string) => void }> | null = null;

  const webTools = (): boolean =>
    (research?.tools ?? []).some((name) => name === "web_search" || name === "find_books" || name === "read_page" || name === "deep_research");

  function updateComposer(): void {
    if (disposed || signal.aborted) return;
    modelHint.textContent = t("a.modelHint");
    deep.hidden = !webTools();
    if (deep.hidden) deepResearch = false;
    deep.setAttribute("aria-pressed", String(deepResearch));
    deep.classList.toggle("rm-on", deepResearch);
    researchSession.hidden = !research?.effective.session;
    composerHandle?.update(composerProps());
    dictationHandle?.update({ disabled: busy(), onTranscript });
  }

  function onTranscript(text: string): void {
    if (signal.aborted || disposed) return;
    draft = draft.length === 0 ? text : `${draft} ${text}`;
    updateComposer();
  }

  async function loadResearch(): Promise<void> {
    try {
      research = await ctx.call<PaneResearchStatus>("research.status");
    } catch {
      research = null;
    }
    updateComposer();
  }

  /** Deep research costs time and tokens: ask once per switch-on. */
  function confirmDeep(): void {
    if (deepResearch) {
      deepResearch = false;
      updateComposer();
      return;
    }
    let dialog: PluginWidgetHandle<PluginDialogProps> | null = null;
    dialog = ctx.ui.openDialog(
      {
        title: t("a.deepTitle"),
        content: (content, contentSignal) => {
          content.append(element(document, "h2", "lp-dialog-title", t("a.deepTitle")));
          content.append(element(document, "p", "lp-dialog-text", t("a.deepWarning")));
          const actions = element(document, "div", "lp-dialog-actions");
          content.append(actions);
          const cancelHost = element(document, "span", "lp-button-host");
          const okHost = element(document, "span", "lp-button-host");
          actions.append(cancelHost, okHost);
          ctx.ui.mountButton(cancelHost, { label: t("a.cancel"), variant: "outline", size: "sm", onClick: () => dialog?.dispose() }, { signal: contentSignal });
          ctx.ui.mountButton(okHost, {
            label: t("a.deepConfirm"),
            size: "sm",
            onClick: () => {
              deepResearch = true;
              dialog?.dispose();
              updateComposer();
            },
          }, { signal: contentSignal });
        },
      },
      { signal },
    );
  }
  deep.addEventListener("click", confirmDeep, { signal });

  /** Open a LearnHarness teaching chat that researches the topic in the draft. */
  async function startResearchSession(): Promise<void> {
    const topic = draft.trim().split("\n")[0]!.slice(0, 300);
    if (!topic) {
      error = t("a.researchNeedsTopic");
      renderStatus();
      return;
    }
    try {
      const prepared = await ctx.call<{ title: string; prompt: string }>("research.prepareSession", {
        topic,
        details: draft.trim().slice(0, 4000),
        locale: locale(),
      });
      const created = await sessionHost.create({ title: prepared.title, kind: "teaching" });
      if (!sessionHost.stageOpeningPrompt(created.chatId, prepared.prompt)) throw new Error(t("a.researchStageFailed"));
      await ctx.call("research.linkSession", { chatId: created.chatId, topic });
      ctx.app.openSession(created.chatId);
    } catch (problem) {
      error = errorMessage(problem);
      renderStatus();
    }
  }
  researchSession.addEventListener("click", () => void startResearchSession(), { signal });

  function renderStatus(): void {
    if (disposed || signal.aborted) return;
    status.className = "lp-architect-status";
    if (error) {
      status.textContent = error;
      status.classList.add("lp-status-error");
      return;
    }
    if (creating || sending || conversation?.status === "running") {
      status.textContent = creating ? t("a.starting") : t("a.thinking");
      status.classList.add("lp-status-busy");
      return;
    }
    if (conversation?.status === "error") {
      status.textContent = conversation.error ?? t("a.failed");
      status.classList.add("lp-status-error");
      return;
    }
    if (conversation?.status === "waiting") {
      status.textContent = t("a.waiting");
      return;
    }
    if (conversation?.status === "interrupted") {
      status.textContent = t("a.stopped");
      return;
    }
    status.textContent = conversation
      ? t("a.ready")
      : t("a.start");
  }

  function disposeHandles(handles: PluginWidgetHandle<unknown>[]): void {
    for (const handle of handles.reverse()) handle.dispose();
  }

  function clearMessages(): void {
    disposeHandles(historyHandles);
    disposeHandles(liveHandles);
    historyHandles = [];
    liveHandles = [];
    history.replaceChildren();
    live.replaceChildren();
    renderedHistoryKey = null;
    historyTurns = 0;
  }

  function appendTurn(
    target: HTMLElement,
    handles: PluginWidgetHandle<unknown>[],
    role: "user" | "assistant",
    text: string,
    partial = false,
  ): void {
    const article = element(
      document,
      "article",
      `lp-chat-turn lp-chat-${role}${partial ? " lp-chat-partial" : ""}`,
    );
    article.dataset.role = role;
    article.append(
      element(document, "span", "lp-chat-role", role === "user" ? t("a.you") : t("a.title")),
    );
    if (role === "assistant") {
      const host = element(document, "div", "lp-chat-markdown");
      article.append(host);
      handles.push(ctx.ui.mountMarkdown(host, { text }, { signal }));
    } else {
      article.append(element(document, "p", "lp-chat-text", text));
    }
    target.append(article);
  }

  /** Reasoning and tool activity. Streaming parts read as in progress; committed
   * ones read as finished, with reasoning collapsed so history stays scannable. */
  function appendProgress(target: HTMLElement, message: unknown, streaming: boolean): number {
    if (!message || typeof message !== "object") return 0;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return 0;
    let count = 0;
    for (const part of content as TextPart[]) {
      if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
        if (streaming) {
          const block = element(document, "div", "lp-chat-reasoning");
          block.append(element(document, "span", "lp-chat-role", t("a.reasoning")));
          block.append(element(document, "p", "lp-chat-text", part.thinking));
          target.append(block);
        } else {
          const block = element(document, "details", "lp-chat-reasoning");
          block.append(element(document, "summary", "lp-chat-role", t("a.reasoning")));
          block.append(element(document, "p", "lp-chat-text", part.thinking));
          target.append(block);
        }
        count++;
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        target.append(
          element(document, "p", "lp-chat-activity", streaming ? t("a.using", { name: String(part.name) }) : t("a.used", { name: String(part.name) })),
        );
        count++;
      }
    }
    return count;
  }

  function renderHistory(): number {
    disposeHandles(historyHandles);
    historyHandles = [];
    history.replaceChildren();
    let turns = 0;
    for (const message of conversation?.messages ?? []) {
      if ((message as { role?: string }).role === "assistant") {
        turns += appendProgress(history, message, false);
      }
      const text = messageText(message);
      if (!text) continue;
      const role = (message as { role: string }).role === "user" ? "user" : "assistant";
      appendTurn(history, historyHandles, role, text);
      turns += 1;
    }
    return turns;
  }

  function renderLive(): number {
    disposeHandles(liveHandles);
    liveHandles = [];
    live.replaceChildren();
    if (!conversation?.partial) return 0;
    let turns = appendProgress(live, conversation.partial, true);
    const text = messageText(conversation.partial);
    if (text) {
      appendTurn(live, liveHandles, "assistant", text, true);
      turns += 1;
    }
    return turns;
  }

  function renderMessages(): void {
    if (disposed || signal.aborted) return;
    // Committed messages are append-only, so id + count identifies the history.
    const key = conversation ? `${conversation.id}:${conversation.messages.length}` : "";
    if (key !== renderedHistoryKey) {
      historyTurns = renderHistory();
      renderedHistoryKey = key;
    }
    const liveTurns = renderLive();
    emptyChat.hidden = historyTurns + liveTurns > 0;
  }

  function setConversation(snapshot: PluginAgentSnapshot | null): void {
    if (disposed || signal.aborted) return;
    ++loadVersion;
    conversation = snapshot;
    error = null;
    renderMessages();
    renderStatus();
    updateComposer();
  }

  function startNew(): void {
    if (signal.aborted || disposed) return;
    if (busy()) {
      error = t("a.stopFirst");
      renderStatus();
      return;
    }
    // Do not allocate a conversation until the learner has chosen the model.
    newDraft = true;
    if (conversation) {
      draft = "";
      model = undefined;
      thinking = undefined;
    }
    setConversation(null);
  }

  async function create(): Promise<string | null> {
    if (signal.aborted || disposed || creating) return null;
    creating = true;
    error = null;
    renderStatus();
    updateComposer();
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.create", {
        requestId: requestId(),
        ...(model
          ? {
              model: {
                provider: model.provider,
                id: model.id,
                ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
              },
            }
          : {}),
      });
      if (signal.aborted || disposed) return null;
      newDraft = false;
      setConversation(result.conversation);
      return result.conversation.id;
    } catch (problem) {
      if (signal.aborted || disposed) return null;
      error = t("a.startFailed", { message: errorMessage(problem) });
      renderStatus();
      return null;
    } finally {
      creating = false;
      renderStatus();
      updateComposer();
    }
  }

  async function load(conversationId: string): Promise<void> {
    if (signal.aborted || disposed) return;
    const version = ++loadVersion;
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.get", {
        id: conversationId,
      });
      if (signal.aborted || disposed || version !== loadVersion) return;
      model = undefined;
      thinking = undefined;
      newDraft = false;
      setConversation(result.conversation);
    } catch (problem) {
      if (signal.aborted || disposed || version !== loadVersion) return;
      error = t("a.loadFailed", { message: errorMessage(problem) });
      renderStatus();
    }
  }

  async function refresh(conversationId: string, messageCount?: number): Promise<void> {
    if (signal.aborted || disposed) return;
    const current = conversation;
    if (!current || current.id !== conversationId || messageCount !== current.messages.length) {
      return load(conversationId);
    }
    const version = ++loadVersion;
    try {
      const result = await ctx.call<{ progress: ArchitectProgress }>("architect.progress", {
        id: conversationId,
      });
      if (signal.aborted || disposed || version !== loadVersion) return;
      const progress = result.progress;
      // History moved on (or the conversation changed) between the hint and the read.
      if (conversation !== current || progress.messageCount !== current.messages.length) {
        return load(conversationId);
      }
      const { partial: _partial, error: _error, ...committed } = current;
      setConversation({
        ...committed,
        status: progress.status,
        pending: progress.pending,
        updatedAt: progress.updatedAt,
        ...(progress.error === undefined ? {} : { error: progress.error }),
        ...(progress.partial === undefined ? {} : { partial: progress.partial }),
      });
    } catch (problem) {
      if (signal.aborted || disposed || version !== loadVersion) return;
      error = t("a.loadFailed", { message: errorMessage(problem) });
      renderStatus();
    }
  }

  async function send(options: { learnerGraph?: boolean } = {}): Promise<void> {
    if (signal.aborted || disposed || busy()) return;
    const text = draft.trim();
    if (!text) return;
    if (!conversation) {
      const id = await create();
      if (!id) return;
    }
    if (!conversation || signal.aborted || disposed) return;
    sending = true;
    error = null;
    renderStatus();
    updateComposer();
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.send", {
        id: conversation.id,
        text: deepResearch ? `${DEEP_RESEARCH_PREFIX}${text}` : text,
        requestId: requestId(),
        ...(options.learnerGraph === true ? { learnerGraph: true } : {}),
      });
      if (signal.aborted || disposed) return;
      draft = "";
      deepResearch = false;
      setConversation(result.conversation);
    } catch (problem) {
      if (signal.aborted || disposed) return;
      error = t("a.sendFailed", { message: errorMessage(problem) });
      renderStatus();
    } finally {
      sending = false;
      updateComposer();
    }
  }

  async function discuss(text: string, options: { learnerGraph?: boolean } = {}): Promise<void> {
    if (signal.aborted || disposed) return;
    draft = text;
    updateComposer();
    if (!conversation) {
      const id = await create();
      if (!id || signal.aborted || disposed) return;
    }
    if (busy()) return;
    await send(options);
  }

  async function stop(): Promise<void> {
    if (signal.aborted || disposed || !conversation) return;
    error = null;
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.abort", {
        id: conversation.id,
        requestId: requestId(),
      });
      if (signal.aborted || disposed) return;
      setConversation(result.conversation);
    } catch (problem) {
      if (signal.aborted || disposed) return;
      error = t("a.stopFailed", { message: errorMessage(problem) });
      renderStatus();
    }
  }

  async function uploadFile(file: File): Promise<void> {
    if (signal.aborted || disposed) return;
    if (uploading) {
      uploadQueue.push(file);
      return;
    }
    if (!ACCEPTED.test(file.name)) {
      uploadStatus.textContent = t("a.unsupported", { name: file.name });
      uploadStatus.dataset.state = "error";
      return;
    }
    uploading = true;
    uploadStatus.className = "lp-upload-status";
    delete uploadStatus.dataset.state;
    uploadStatus.textContent = t("a.converting", { name: file.name });
    try {
      const converted = await ctx.documents.toMarkdown(file, { signal });
      if (signal.aborted || disposed) return;
      const saved = await ctx.call<{ reference: { name: string }; deduplicated: boolean }>(
        "sources.save",
        { name: converted.name, markdown: converted.markdown },
      );
      if (signal.aborted || disposed) return;
      const notices = converted.notices.length > 0 ? ` ${converted.notices.join(" ")}` : "";
      uploadStatus.textContent = saved.deduplicated
        ? t("a.already", { name: saved.reference.name, notices })
        : t("a.added", { name: saved.reference.name, notices });
      uploadStatus.dataset.state = "success";
    } catch (problem) {
      if (signal.aborted || disposed) return;
      uploadStatus.textContent = t("a.useFailed", { name: file.name, message: errorMessage(problem) });
      uploadStatus.dataset.state = "error";
    } finally {
      uploading = false;
      const next = uploadQueue.shift();
      if (next && !signal.aborted && !disposed) void uploadFile(next);
    }
  }

  // Drag books and notes onto the Architect: a drop target over the whole pane.
  let dragDepth = 0;
  const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  root.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropHint.hidden = false;
    root.classList.add("rm-dragging");
  }, { signal });
  root.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, { signal });
  root.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropHint.hidden = true;
      root.classList.remove("rm-dragging");
    }
  }, { signal });
  root.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    root.classList.remove("rm-dragging");
    for (const file of Array.from(event.dataTransfer?.files ?? [])) void uploadFile(file);
  }, { signal });

  const onFileChange = (): void => {
    if (signal.aborted || disposed) return;
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    for (const file of files) void uploadFile(file);
  };
  fileInput.addEventListener("change", onFileChange, { signal });

  composerHandle = ctx.ui.mountComposer(composerHost, composerProps(), { signal });
  dictationHandle = ctx.ui.mountDictation(dictationHost, { disabled: busy(), onTranscript }, { signal });
  const offNotification = ctx.onNotification((event) => {
    if (event.topic === "settings-changed" || event.topic === "research-notes-changed") void loadResearch();
  });
  void loadResearch();
  updateComposer();
  renderMessages();
  renderStatus();

  return {
    element: root,
    startNew,
    load,
    refresh,
    setConversation,
    discuss,
    conversationId: () => conversation?.id ?? null,
    isNewDraft: () => newDraft,
    uploadFile,
    dispose() {
      if (disposed) return;
      disposed = true;
      fileInput.removeEventListener("change", onFileChange);
      clearMessages();
      offNotification();
      dictationHandle?.dispose();
      composerHandle?.dispose();
      composerHandle = null;
      root.remove();
    },
  };
}
