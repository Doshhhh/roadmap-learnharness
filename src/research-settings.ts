/** Settings section "Research": how the Architect reaches beyond its memory.
 * Every channel can be switched off; turned-off channels hide their own rows. */
import type { PluginFrontendContext, PluginSettingsRow, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import { HYBRID_RESEARCH, KEY_ENGINES, RESEARCH_PRESETS } from "./domain.ts";
import type { KeyEngine, PluginSettings, ResearchPreset, ResearchSettings } from "./domain.ts";
import { t } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";

/** Tool name (as the Architect sees it) to the plain-words capability shown in settings. */
const CAPABILITY_KEYS: Partial<Record<string, MessageKey>> = {
  read_page: "r.cap.pages",
  find_books: "r.cap.books",
  book_contents: "r.cap.books",
  find_papers: "r.cap.papers",
  search_wikipedia: "r.cap.encyclopedia",
  web_search: "r.cap.web",
  deep_research: "r.cap.deep",
};

export interface ResearchStatus {
  readonly effective: ResearchSettings;
  readonly keys: Record<KeyEngine, boolean>;
  readonly claudeCli: boolean;
  readonly hostWebBuilt: boolean;
  readonly hostWeb: boolean;
  readonly hostSearch?: boolean;
  readonly notes: readonly { id: string; title: string; origin: string; createdAt: string; size: number }[];
  readonly tools: readonly string[];
}

const make = <K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function mountResearchSettings(
  ctx: PluginFrontendContext,
  host: HTMLElement,
  options: {
    signal: AbortSignal;
    settings: () => PluginSettings;
    save: (next: PluginSettings) => Promise<boolean>;
    onError: (message: string) => void;
  },
): { render(): Promise<void>; dispose(): void } {
  const document = host.ownerDocument;
  const rowsHost = make(document, "div", "lp-settings-rows");
  const extra = make(document, "div", "rm-research-extra");
  host.append(rowsHost, extra);
  let rows: PluginWidgetHandle<PluginSettingsSchema> | null = null;
  let status: ResearchStatus | null = null;

  const current = (): ResearchSettings => options.settings().research ?? HYBRID_RESEARCH;
  const write = (patch: Partial<ResearchSettings>): void => {
    const base = current();
    // Changing any single channel turns a preset into "custom" starting from what the preset meant.
    const start = base.preset === "custom" || patch.preset !== undefined ? base : { ...(status?.effective ?? base), preset: "custom" as const };
    void options.save({ ...options.settings(), research: { ...start, ...patch } }).then(() => render());
  };

  async function render(): Promise<void> {
    if (options.signal.aborted) return;
    try {
      status = await ctx.call<ResearchStatus>("research.status");
    } catch (problem) {
      options.onError(problem instanceof Error ? problem.message : String(problem));
      return;
    }
    if (options.signal.aborted) return;
    const value = current();
    const effective = status.effective;
    const list: PluginSettingsRow[] = [
      {
        key: "research-preset",
        type: "dropdown",
        label: t("r.preset"),
        description: t(`r.presetDesc.${value.preset}` as MessageKey),
        value: value.preset,
        options: RESEARCH_PRESETS.map((preset) => ({ value: preset, label: t(`r.preset.${preset}` as MessageKey) })),
        onChange: (preset: string) => write({ preset: preset as ResearchPreset }),
      },
    ];
    if (value.preset === "custom") {
      list.push(
        { key: "research-session", type: "toggle", label: t("r.session"), description: t("r.sessionDesc"), value: effective.session, onChange: (on: boolean) => write({ session: on }) },
        { key: "research-open", type: "toggle", label: t("r.open"), description: t("r.openDesc"), value: effective.openSources, onChange: (on: boolean) => write({ openSources: on }) },
        {
          key: "research-cli",
          type: "toggle",
          label: t("r.cli"),
          description: status.claudeCli ? t("r.cliDesc") : t("r.cliMissing"),
          value: effective.claudeCli,
          disabled: !status.claudeCli && !effective.claudeCli,
          onChange: (on: boolean) => write({ claudeCli: on }),
        },
        { key: "research-key", type: "toggle", label: t("r.key"), description: t("r.keyDesc"), value: effective.ownKey, onChange: (on: boolean) => write({ ownKey: on }) },
      );
      if (effective.ownKey) {
        list.push(
          {
            key: "research-engine",
            type: "dropdown",
            label: t("r.engine"),
            value: effective.keyEngine,
            options: KEY_ENGINES.map((engine) => ({ value: engine, label: engine === "tavily" ? "Tavily" : "Brave Search" })),
            onChange: (engine: string) => write({ keyEngine: engine as KeyEngine }),
          },
          {
            key: "research-key-value",
            type: "text",
            label: status.keys[effective.keyEngine] ? t("r.keySaved") : t("r.keyEnter"),
            description: t("r.keyStorage"),
            value: "",
            onChange: async (key: string) => {
              if (!key.trim()) return;
              try {
                await ctx.call("research.setKey", { engine: effective.keyEngine, key });
              } catch (problem) {
                options.onError(problem instanceof Error ? problem.message : String(problem));
              }
              await render();
            },
          },
        );
      }
      if (status.hostWebBuilt) {
        list.push({
          key: "research-host",
          type: "toggle",
          label: t("r.host"),
          description: status.hostSearch ? t("r.hostDesc") : status.hostWeb ? t("r.hostNoSearch") : t("r.hostMissing"),
          value: effective.hostWeb,
          onChange: (on: boolean) => write({ hostWeb: on }),
        });
      }
    }
    if (rows) rows.update({ rows: list });
    else rows = ctx.ui.mountSettingsRows(rowsHost, { rows: list }, { signal: options.signal });

    extra.replaceChildren();
    if (value.preset === "custom" && effective.ownKey) {
      extra.append(make(document, "p", "rm-research-warning", t("r.keyWarning")));
      if (status.keys[effective.keyEngine]) {
        const remove = make(document, "button", "lp-button", t("r.keyRemove"));
        remove.type = "button";
        remove.addEventListener("click", async () => {
          await ctx.call("research.clearKey", { engine: effective.keyEngine }).catch(() => undefined);
          await render();
        }, { signal: options.signal });
        extra.append(remove);
      }
    }
    // Shown as what the Architect can do, never as tool names. Saved-note tools have no entry, so they do not count as a source.
    const capabilities = [...new Set(status.tools.map((name) => CAPABILITY_KEYS[name]).filter((key): key is MessageKey => key !== undefined).map((key) => t(key)))];
    extra.append(make(document, "p", "rm-research-tools", capabilities.length ? t("r.activeTools", { list: capabilities.join(", ") }) : t("r.offline")));
    if (status.notes.length) {
      const heading = make(document, "h3", "rm-research-notes-title", t("r.notes"));
      const notes = make(document, "ul", "rm-research-notes");
      for (const note of status.notes) {
        const item = make(document, "li");
        item.append(make(document, "span", undefined, `${note.title} · ${t(`r.origin.${note.origin}` as MessageKey)} · ${new Date(note.createdAt).toLocaleDateString()}`));
        const remove = make(document, "button", "rm-link-button", t("r.noteDelete"));
        remove.type = "button";
        remove.addEventListener("click", async () => {
          await ctx.call("research.deleteNote", { noteId: note.id }).catch(() => undefined);
          await render();
        }, { signal: options.signal });
        item.append(remove);
        notes.append(item);
      }
      extra.append(heading, notes);
    }
  }

  return {
    render,
    dispose() {
      rows?.dispose();
      rows = null;
      rowsHost.remove();
      extra.remove();
    },
  };
}
