/** Roadmap view tests (formerly the Path Hub).
 *
 * Public-API test double only: the real view is mounted against a recorded host
 * UI and an in-memory JSON backend. These tests prove disposal, the bottom-up
 * roadmap and tree, node panel edits, Architect chat state, document-conversion
 * failures and `onResync` recovery without a browser or a model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentSnapshot } from "learnharness-plugin-api";
import { mountPathHub } from "../src/view/path-hub.ts";
import { effectiveArtifact } from "../src/view/node-inspector.ts";
import { ARTIFACT_CATALOG } from "../src/domain.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { canvasNode, chooseMenuItem, click, inspector, selectNode } from "./roadmap-dom.ts";
import { createViewFixture, fire, makeConversation, setSelect } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function assistant(text: string): PluginAgentSnapshot["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as PluginAgentSnapshot["messages"][number];
}

function user(text: string): PluginAgentSnapshot["messages"][number] {
  return { role: "user", content: text, timestamp: Date.now() };
}

function snapshot(id: string, overrides: Partial<PluginAgentSnapshot> = {}): PluginAgentSnapshot {
  return makeConversation(id, overrides);
}

async function mounted(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  await fixture.flush();
  return container;
}

function liveButtons(fixture: ViewFixture): MountRecord[] {
  return fixture.all("mountButton");
}

/** Toolbar buttons are plain Learny buttons; expose them like mount records for the Architect tests. */
function toolbar(fixture: ViewFixture, label: string): HTMLButtonElement {
  const found = [...fixture.root.querySelectorAll<HTMLButtonElement>(".rm-top button")].find((button) => button.textContent === label);
  assert.ok(found, `Missing toolbar button ${label}`);
  return found;
}

test("the roadmap view mounts every surface and disposes widgets and listeners on unmount", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("Here is a plan.")] })],
  });
  try {
    const container = await mounted(fixture);

    assert.ok(container.querySelector(".rm-top"), "toolbar");
    assert.ok(container.querySelector(".rm-canvas .rm-stage"), "graph canvas");
    assert.ok(container.querySelector(".rm-side .rm-tabs"), "side panel tabs");
    assert.equal(fixture.all("mountTree").length, 0, "the roadmap draws its own map instead of a host tree");
    assert.equal(fixture.all("mountComposer").length, 1);
    assert.equal(fixture.all("mountStandardComposer").length, 0, "model and thinking live in settings, not in the composer");
    assert.equal(fixture.all("mountMarkdown").length, 1, "the stored Architect turn is rendered as Markdown");
    toolbar(fixture, "New roadmap");
    toolbar(fixture, "Refine");
    assert.ok(container.querySelector(".rm-composer .rm-chip-button"), "the composer offers attaching books and notes");
    assert.equal(container.querySelector(".rm-crumb-path")!.textContent, "Linear algebra from canon");
    assert.match(container.querySelector(".rm-status-summary")!.textContent ?? "", /consolidated 1 of 6 · in progress 2/);
    assert.match(container.querySelector(".rm-status-errors")!.textContent ?? "", /1 open error/);

    const callsBefore = fixture.calls.length;
    fixture.controller.abort();
    await fixture.flush();

    assert.equal(container.childElementCount, 0, "the view root removes itself");
    assert.ok(fixture.records.length > 0);
    assert.ok(
      fixture.records.every((record) => record.disposed >= 1),
      "every ctx.ui handle is disposed through its signal",
    );

    fixture.emit("paths-changed", { id: path.id });
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsBefore, "aborted listeners stop refetching");
  } finally {
    fixture.restore();
  }
});

test("the graph lays modules bottom-up, expands the working module and follows selection", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    const root = fixture.root;
    // The first in-progress node opens in the panel; its module is the expanded box.
    assert.equal(inspector(fixture).dataset.nodeId, "n-concept");
    const box = root.querySelector<HTMLElement>(".rm-box")!;
    assert.equal(box.dataset.moduleId, "module-structure");
    assert.match(box.textContent ?? "", /Structure first.*in progress · 1 \/ 3/s);
    assert.match(box.textContent ?? "", /1 open error: Drops a sign while expanding\./);
    const synthesis = root.querySelector<HTMLElement>('.rm-box[data-module-id="module-synthesis"]')!;
    assert.ok(synthesis, "every module is a frame in the graph");
    assert.ok(
      parseFloat(synthesis.style.top) < parseFloat(box.style.top),
      "the later module sits above the earlier one (bottom-up)",
    );
    assert.ok(canvasNode(fixture, "n-concept").classList.contains("rm-sel"));
    assert.ok(canvasNode(fixture, "n-holistic").classList.contains("rm-done"));
    assert.ok(canvasNode(fixture, "n-skill").querySelector(".rm-node-warn"), "open errors are flagged on the node");
    assert.ok(root.querySelectorAll(".rm-edges line").length > 0);
    assert.ok(root.querySelector(".rm-edges .rm-arrow"), "dependency arrows have heads");

    const panel = inspector(fixture);
    assert.match(panel.textContent ?? "", /Understand n-concept from first principles\./);
    assert.match(panel.textContent ?? "", /OSTEP · ch\. 26 · §27\.1 · pp\. 301-320/);
    assert.match(panel.textContent ?? "", /Before the lesson: Skim the module overview and the running example\./);
    assert.match(panel.textContent ?? "", /Why: a small program/);
    assert.equal(panel.querySelector<HTMLSelectElement>('select[aria-label="Artifact"]')!.value, "micro_code");

    // Interleaved prior nodes are followable.
    click(panel, "Node n-holistic");
    await fixture.flush();
    assert.equal(inspector(fixture).dataset.nodeId, "n-holistic");

    // Clicking a collapsed module expands it; selecting its node keeps it expanded.
    root.querySelector<HTMLButtonElement>('.rm-box[data-module-id="module-synthesis"] .rm-box-head')!.click();
    await fixture.flush();
    assert.equal(root.querySelector<HTMLElement>(".rm-box-focus")!.dataset.moduleId, "module-synthesis");
    await selectNode(fixture, "n-contrast");
    assert.equal(inspector(fixture).dataset.nodeId, "n-contrast");
    assert.equal(root.querySelector<HTMLElement>(".rm-box-focus")!.dataset.moduleId, "module-synthesis");

    // Tree view lists modules and nodes; selection survives switching views.
    toolbar(fixture, "Tree").click();
    await fixture.flush();
    assert.equal(root.querySelector<HTMLElement>(".rm-viewport")!.hidden, true);
    assert.equal(root.querySelector<HTMLElement>(".rm-tree")!.hidden, false);
    assert.ok(canvasNode(fixture, "n-contrast").classList.contains("rm-sel"));
    assert.deepEqual(
      [...root.querySelectorAll(".rm-tree .rm-tree-row .rm-node-title")].map((node) => node.textContent),
      ["Node n-holistic", "Node n-concept", "Node n-skill", "Node n-contrast", "Node n-checkpoint", "Node n-bridge"],
    );

    // Session rows open the native chat.
    await selectNode(fixture, "n-skill");
    toolbar(fixture, "Graph").click();
    await fixture.flush();
    await selectNode(fixture, "n-concept");
    const session = inspector(fixture).querySelector<HTMLButtonElement>(".rm-session-open")!;
    session.click();
    assert.deepEqual(fixture.openedSessions, ["chat-1"]);
  } finally {
    fixture.restore();
  }
});

test("node panel persists status and artifact choices and refreshes the map and progress", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    await selectNode(fixture, "n-concept");

    inspector(fixture).querySelector<HTMLButtonElement>(".rm-status")!.click();
    const menu = await chooseMenuItem(fixture, "consolidated");
    assert.deepEqual(menu.items.map((item) => item.key), ["unstarted", "in_progress", "consolidated", "skipped"]);
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      progression: "consolidated",
    });
    assert.match(fixture.root.querySelector(".rm-status-summary")!.textContent ?? "", /consolidated 2 of 6 · in progress 1/);
    assert.ok(canvasNode(fixture, "n-concept").classList.contains("rm-done"));

    // Skipped counts as done and is drawn struck through.
    inspector(fixture).querySelector<HTMLButtonElement>(".rm-status")!.click();
    await chooseMenuItem(fixture, "skipped");
    assert.ok(canvasNode(fixture, "n-concept").classList.contains("rm-skip"));
    assert.match(fixture.root.querySelector(".rm-status-summary")!.textContent ?? "", /consolidated 2 of 6/);

    const artifact = () => inspector(fixture).querySelector<HTMLSelectElement>('select[aria-label="Artifact"]')!;
    setSelect(artifact(), "relational_map");
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      artifactType: "relational_map",
    });
    const updated = fixture.paths.get(path.id)!;
    const node = updated.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!;
    assert.equal(effectiveArtifact(updated, node), "relational_map");
    assert.match(inspector(fixture).querySelector(".rm-why")!.textContent ?? "", /labelled arrows/);

    // Clearing the override falls back to the path default and keeps the reason.
    setSelect(artifact(), "");
    await fixture.flush();
    const afterClear = fixture.paths.get(path.id)!;
    assert.equal(afterClear.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!.artifactConfig, null);
    assert.match(
      inspector(fixture).querySelector(".rm-why")!.textContent ?? "",
      /a few short memory cues/,
      "the path default (retrieval cue) now supplies the reason",
    );
    assert.equal(ARTIFACT_CATALOG.length, 6);
  } finally {
    fixture.restore();
  }
});

test("Architect chat sends, shows busy state and adopts notification snapshots as Markdown turns", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [
      snapshot("chat-architect", { messages: [user("Build me a linear algebra path."), assistant("Here is a plan.")] }),
    ],
  });
  try {
    await mounted(fixture);
    assert.equal(fixture.all("mountMarkdown").length, 1);
    assert.equal(fixture.find("mountMarkdown").props.text, "Here is a plan.");

    const composer = fixture.find("mountComposer");
    assert.equal(composer.props.value, "");
    assert.equal(composer.props.busy, false);
    assert.equal(typeof composer.props.onStop, "function");
    assert.equal(typeof fixture.find("mountDictation").props.onTranscript, "function");

    await composer.props.onChange("Refine module two.");
    assert.equal(fixture.find("mountComposer").props.value, "Refine module two.");

    await composer.props.onSend();
    await fixture.flush();
    const send = fixture.calls.filter((call) => call.name === "architect.send").at(-1);
    assert.ok(send);
    assert.deepEqual(
      { id: (send.input as { id: string }).id, text: (send.input as { text: string }).text },
      { id: "chat-architect", text: "Refine module two." },
    );
    assert.equal(fixture.find("mountComposer").props.busy, true);
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-architect-status")!.textContent ?? "",
      /The Architect is thinking/,
    );

    const updated = structuredClone(fixture.conversations.get("chat-architect")!);
    updated.status = "idle";
    updated.messages = [...updated.messages, assistant("Module two now has a contrast node.")];
    fixture.conversations.set("chat-architect", updated);
    fixture.emit("architect-changed", { id: "chat-architect", kind: "state", status: "idle" });
    await fixture.flush();

    assert.equal(fixture.find("mountComposer").props.busy, false);
    assert.ok(
      fixture.all("mountMarkdown").some((markdown) => markdown.props.text === "Module two now has a contrast node."),
    );
    assert.equal(fixture.find("mountComposer").props.value, "");

    // New roadmap starts a fresh Architect conversation and opens the Architect tab.
    toolbar(fixture, "New roadmap").click();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 0,
      "opening the composer must leave time to select a model before creating a conversation");
    assert.match(fixture.find("mountComposer").props.placeholder, /goal|цель/i);
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    assert.match(fixture.find("mountComposer").props.placeholder, /goal|цель/i,
      "a path refresh must not replace the new draft with the old chat");
    assert.ok(toolbar(fixture, "Refine").classList.contains("rm-active"), "New roadmap opens the Architect tab");
    assert.equal(fixture.root.querySelector<HTMLElement>(".rm-panel-architect")!.hidden, false);
  } finally {
    fixture.restore();
  }
});

test("the composer uses the settings model, sends deep research only when confirmed, and accepts dropped books", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    await fixture.flush();
    const composer = fixture.find("mountComposer");
    assert.match(fixture.root.querySelector(".rm-model-hint")?.textContent ?? "", /settings/);
    const deep = fixture.root.querySelector<HTMLButtonElement>(".rm-deep")!;
    assert.equal(deep.hidden, false, "deep research is offered when research tools exist");
    deep.click();
    const dialog = fixture.find("openDialog");
    assert.ok(dialog, "turning deep research on asks for confirmation first");
    await composer.props.onChange("Teach me geometry");
    await composer.props.onSend();
    await fixture.flush();
    const created = fixture.calls.find((call) => call.name === "architect.create");
    assert.equal((created?.input as { model?: unknown }).model, undefined, "no model is chosen in the composer");
    const send = fixture.calls.find((call) => call.name === "architect.send");
    assert.equal((send?.input as { text: string }).text, "Teach me geometry", "unconfirmed deep research is not sent");
  } finally {
    fixture.restore();
  }
});

test("Architect shows streamed reasoning and tool activity while a path is being built", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect", { status: "running" })] });
  try {
    await mounted(fixture);
    const progress = structuredClone(fixture.conversations.get("chat-architect")!);
    progress.partial = { role: "assistant", content: [
      { type: "thinking", thinking: "Map the chapter headings to the concepts." },
      { type: "toolCall", name: "read_uploaded_source_chunk", id: "call-1", arguments: {} },
      { type: "text", text: "Drafting the outline…" },
    ] } as unknown as PluginAgentSnapshot["partial"];
    fixture.conversations.set("chat-architect", progress);
    fixture.emit("architect-changed", { id: "chat-architect" });
    await fixture.flush();
    assert.match(fixture.root.querySelector(".lp-chat-reasoning")?.textContent ?? "", /Map the chapter headings/);
    assert.match(fixture.root.querySelector(".lp-chat-activity")?.textContent ?? "", /read_uploaded_source_chunk/);
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Drafting the outline…"));
  } finally {
    fixture.restore();
  }
});

test("background refreshes keep the conversation in view and select the path it creates", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    toolbar(fixture, "New roadmap").click();
    const composer = fixture.find("mountComposer");
    await composer.props.onChange("Teach me shaders");
    await composer.props.onSend();
    await fixture.flush();
    const created = fixture.calls.find((call) => call.name === "architect.create");
    assert.ok(created);
    const newChat = [...fixture.conversations.keys()].find((id) => id !== "chat-architect")!;
    const loads = () => fixture.calls.filter((call) => call.name === "architect.get" &&
      (call.input as { id: string }).id === "chat-architect").length;
    const before = loads();

    // Child-chat progress on the selected path must not switch the pane back.
    fixture.emit("paths-changed", { id: "path-linear-algebra" });
    await fixture.flush();
    assert.equal(loads(), before, "the running new conversation stays in view");

    // The new conversation saves its path: the hub selects it.
    const shaders = { ...makePath(), id: "path-shaders", title: "Shaders", architectChatId: newChat };
    fixture.paths.set(shaders.id, shaders);
    fixture.emit("paths-changed", { id: shaders.id, created: true });
    await fixture.flush();
    assert.equal(loads(), before);
    assert.equal(fixture.root.querySelector(".rm-crumb-path")!.textContent, "Shaders");
  } finally {
    fixture.restore();
  }
});

test("Refine over an unsent draft opens the selected roadmap's conversation", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    toolbar(fixture, "New roadmap").click();
    await fixture.flush();
    const fresh = fixture.find("mountComposer").props.placeholder;
    toolbar(fixture, "Refine").click(); // back to the node tab
    toolbar(fixture, "Refine").click(); // reopen for the selected roadmap
    await fixture.flush();
    assert.notEqual(fixture.find("mountComposer").props.placeholder, fresh,
      "the path's existing conversation replaced the draft");
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 0);
  } finally {
    fixture.restore();
  }
});

test("streamed progress re-renders only the live turn, not the committed history", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect", {
      status: "running",
      messages: [user("Build a path"), assistant("First outline."), assistant("Second outline.")],
    })],
  });
  try {
    await mounted(fixture);
    const historyMounts = () => fixture.all("mountMarkdown").filter((mount) =>
      mount.props.text === "First outline." || mount.props.text === "Second outline.").length;
    const initial = historyMounts();
    assert.equal(initial, 2);
    const fullReads = () => fixture.calls.filter((call) => call.name === "architect.get").length;
    const readsBefore = fullReads();
    for (const text of ["Draft…", "Draft, more…"]) {
      const progress = structuredClone(fixture.conversations.get("chat-architect")!);
      progress.partial = { role: "assistant", content: [{ type: "text", text }] } as unknown as PluginAgentSnapshot["partial"];
      fixture.conversations.set("chat-architect", progress);
      fixture.emit("architect-changed", { id: "chat-architect", messageCount: 3, partial: true });
      await fixture.flush();
    }
    assert.equal(historyMounts(), initial, "history markdown is not remounted per progress tick");
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Draft, more…"));
    assert.equal(fullReads(), readsBefore, "progress ticks never refetch the committed history");
    assert.equal(fixture.calls.filter((call) => call.name === "architect.progress").length, 2);

    // A committed message changes the count: the full conversation is reloaded.
    const committed = structuredClone(fixture.conversations.get("chat-architect")!);
    committed.messages = [...committed.messages, assistant("Third outline.")];
    delete committed.partial;
    committed.status = "idle";
    fixture.conversations.set("chat-architect", committed);
    fixture.emit("architect-changed", { id: "chat-architect", messageCount: 4, partial: false });
    await fixture.flush();
    assert.equal(fullReads(), readsBefore + 1);
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Third outline."));
    assert.ok(!fixture.root.querySelector(".lp-chat-partial"), "the finished partial is gone");
  } finally {
    fixture.restore();
  }
});

test("document upload surfaces conversion errors without saving and saves on success", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    const input = fixture.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.ok(input, "the Architect surface owns a native file picker");
    const file = new File(["not text"], "broken.pdf", { type: "application/pdf" });

    fixture.toMarkdown = async () => {
      throw new Error("Only UTF-8 text or a valid PDF can be converted.");
    };
    Object.defineProperty(input, "files", { configurable: true, value: { length: 1, 0: file, item: () => file } });
    fire(input, "change");
    await fixture.flush();

    const status = () => fixture.root.querySelector<HTMLElement>(".lp-upload-status")!;
    assert.equal(status().dataset.state, "error");
    assert.match(status().textContent ?? "", /Could not use broken\.pdf/);
    assert.match(status().textContent ?? "", /Only UTF-8 text or a valid PDF/);
    assert.equal(fixture.uploaded.length, 0, "a failed conversion never reaches sources.save");
    assert.equal(fixture.calls.filter((call) => call.name === "sources.save").length, 0);
    assert.equal(fixture.find("mountComposer").props.value, "", "the draft is untouched");

    const good = new File(["# Book"], "book.md", { type: "text/markdown" });
    fixture.toMarkdown = async () => ({
      name: "book.md",
      markdown: "# Book\n\nConverted content.",
      notices: ["Page 2 was image-only and was skipped."],
    });
    Object.defineProperty(input, "files", { configurable: true, value: { length: 1, 0: good, item: () => good } });
    fire(input, "change");
    await fixture.flush();

    assert.deepEqual(fixture.uploaded, [{ name: "book.md", markdown: "# Book\n\nConverted content." }]);
    assert.equal(status().dataset.state, "success");
    assert.match(status().textContent ?? "", /Added book\.md/);
    assert.match(status().textContent ?? "", /Page 2 was image-only/);
    assert.equal(fixture.calls.filter((call) => call.name === "sources.save").length, 1);
  } finally {
    fixture.restore();
  }
});

test("onResync re-reads paths and the Architect conversation after missed notifications", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("First plan.")] })],
  });
  try {
    await mounted(fixture);
    const title = () => fixture.root.querySelector<HTMLElement>(".rm-crumb-path")!.textContent ?? "";
    assert.equal(title(), "Linear algebra from canon");

    const changed: LearningPath = { ...path, title: "Renamed after reconnect", updatedAt: "2026-02-02T00:00:00.000Z" };
    fixture.paths.set(path.id, changed);
    const conversation = structuredClone(fixture.conversations.get("chat-architect")!);
    conversation.messages = [...conversation.messages, assistant("Recovered plan after reconnect.")];
    fixture.conversations.set("chat-architect", conversation);
    await fixture.flush();
    assert.equal(title(), "Linear algebra from canon", "a missed notification leaves the view stale");

    const before = fixture.calls.length;
    fixture.resync();
    await fixture.flush();
    await fixture.flush();
    const names = fixture.calls.slice(before).map((call) => call.name);
    assert.ok(names.includes("paths.list"));
    assert.ok(names.includes("paths.get"));
    assert.ok(names.includes("architect.get"));
    assert.equal(title(), "Renamed after reconnect");
    assert.ok(
      fixture.all("mountMarkdown").some((markdown) => markdown.props.text === "Recovered plan after reconnect."),
      "the Architect transcript recovers from the authoritative snapshot",
    );

    const callsAfterResync = fixture.calls.length;
    fixture.controller.abort();
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsAfterResync, "resync listeners are released with the view");
  } finally {
    fixture.restore();
  }
});

test("the toolbar shows only the roadmap title and its dropdown, with no breadcrumb label or separator", async () => {
  const path = makePath();
  const shaders = { ...makePath(), id: "path-shaders", title: "Shaders" };
  const fixture = createViewFixture({ paths: [path, shaders] });
  try {
    const container = await mounted(fixture);
    const crumb = container.querySelector<HTMLElement>(".rm-top .rm-crumb")!;
    assert.ok(crumb, "the title lives in the toolbar crumb");
    assert.equal(crumb.textContent, "Linear algebra from canon", "the crumb is the title alone");
    assert.equal(container.querySelector(".rm-crumb-sep"), null, "no slash separator");
    assert.doesNotMatch(container.querySelector(".rm-top")!.textContent ?? "", /Roadmaps/, "no 'Roadmaps' label in the toolbar");
    assert.ok(container.querySelector(".rm-crumb-path .rm-crumb-chevron"), "the title keeps its chevron");
    assert.equal(container.querySelector<HTMLButtonElement>(".rm-crumb-path")!.disabled, false);
  } finally {
    fixture.restore();
  }
});

test("the title dropdown lists every roadmap and switches between them", async () => {
  const path = makePath();
  const shaders = { ...makePath(), id: "path-shaders", title: "Shaders" };
  const fixture = createViewFixture({ paths: [path, shaders] });
  try {
    const container = await mounted(fixture);
    container.querySelector<HTMLButtonElement>(".rm-crumb-path")!.click();
    await fixture.flush();

    const menu = await chooseMenuItem(fixture, shaders.id);
    assert.deepEqual(menu.items.map((item) => item.key), [path.id, shaders.id], "every roadmap is listed");
    assert.equal(menu.label, "Roadmaps", "the menu keeps its accessible name");
    assert.equal(container.querySelector(".rm-crumb-path")!.textContent, "Shaders", "selecting an item switches roadmaps");
  } finally {
    fixture.restore();
  }
});

test("with no roadmaps the title dropdown is disabled and opens no menu", async () => {
  const fixture = createViewFixture();
  try {
    const container = await mounted(fixture);
    const pathSwitch = container.querySelector<HTMLButtonElement>(".rm-crumb-path")!;
    assert.equal(pathSwitch.disabled, true);
    assert.ok(pathSwitch.querySelector(".rm-crumb-chevron"), "the disabled title keeps its chevron");
    assert.doesNotMatch(container.querySelector(".rm-top")!.textContent ?? "", /Roadmaps/);
    pathSwitch.click();
    await fixture.flush();
    assert.equal(fixture.all("openMenu").length, 0, "no menu opens without roadmaps");
  } finally {
    fixture.restore();
  }
});

test("an empty view opens the Architect and does not invent a map or a node", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    assert.equal(fixture.root.querySelector<HTMLElement>(".rm-panel-architect")!.hidden, false);
    assert.equal(fixture.root.querySelector<HTMLElement>(".rm-side")!.hidden, false);
    assert.match(fixture.root.textContent ?? "", /No roadmaps yet/);
    assert.match(inspector(fixture).textContent ?? "", /Select a node/);
    assert.equal(fixture.root.querySelectorAll(".rm-node").length, 0, "no nodes without a roadmap");
    assert.equal(toolbar(fixture, "Refine").disabled, true);
    toolbar(fixture, "New roadmap").click();
    await fixture.flush();
    assert.equal(fixture.conversations.size, 0, "opening a draft does not lock in the model yet");
    assert.equal(fixture.paths.size, 0, "the Architect creates roadmaps through save_learning_path, not the toolbar");
    assert.ok(fixture.all("mountMarkdown").length === 0);
  } finally {
    fixture.restore();
  }
});

test("a refused roadmap file is named in the hub banner with the Git view to resolve it", async () => {
  const filename = "/data/roadmaps/abc.json";
  const fixture = createViewFixture({ paths: [makePath()], refused: [{ filename, code: "corrupt" }] });
  try {
    await mounted(fixture);
    await fixture.flush();
    const banner = fixture.root.querySelector<HTMLElement>(".rm-hub-error")!;
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent ?? "", /\/data\/roadmaps\/abc\.json/);
    assert.match(banner.textContent ?? "", /Resolve it in the Git view/);
  } finally {
    fixture.restore();
  }
});
