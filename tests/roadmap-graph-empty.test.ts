/** Empty roadmap state: "Build from my graph" depends on the graph's topic count from the brief. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readGraphTopicCount } from "../src/backend.ts";
import type { BriefGraph } from "../src/graph-brief.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { createViewFixture } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

async function mountEmpty(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  await fixture.flush();
  return container;
}

function buildButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(".rm-empty-build");
  assert.ok(found, "the empty state offers the graph build button");
  return found;
}

test("the empty roadmap state offers an enabled 'Build from my graph' when the graph has topics", async () => {
  const fixture = createViewFixture({ paths: [], graphTopics: 3 });
  try {
    const container = await mountEmpty(fixture);
    assert.equal(container.querySelector(".rm-empty-title")?.textContent, "No roadmaps yet");
    const build = buildButton(container);
    assert.equal(build.textContent, "Build from my graph");
    assert.equal(build.disabled, false);
    assert.equal(container.querySelector(".rm-empty-hint"), null, "no hint when the button works");
    assert.ok(fixture.calls.some((call) => call.name === "graph.topicCount"), "the count comes from the backend brief");
  } finally {
    fixture.controller.abort();
  }
});

test("with an empty graph the button is disabled and a one-line hint says what is needed", async () => {
  const fixture = createViewFixture({ paths: [], graphTopics: 0 });
  try {
    const container = await mountEmpty(fixture);
    const build = buildButton(container);
    assert.equal(build.disabled, true);
    const hint = container.querySelector(".rm-empty-hint");
    assert.ok(hint, "a hint explains why the button is off");
    assert.equal(hint.textContent, "Study some material first: the graph has no topics yet.");
  } finally {
    fixture.controller.abort();
  }
});

test("clicking 'Build from my graph' opens the Architect and sends with learnerGraph: true", async () => {
  const fixture = createViewFixture({ paths: [], graphTopics: 2 });
  try {
    const container = await mountEmpty(fixture);
    const build = buildButton(container);
    build.click();
    for (let i = 0; i < 4; i += 1) await fixture.flush();
    const names = fixture.calls.map((call) => call.name);
    const created = names.indexOf("architect.create");
    const sent = names.indexOf("architect.send");
    assert.ok(created >= 0 && sent > created, "a fresh Architect conversation is created, then the first message is sent");
    const sendCall = fixture.calls[sent];
    assert.ok(sendCall, "the architect.send call is recorded");
    const send = sendCall.input as { learnerGraph?: boolean; text?: string };
    assert.equal(send.learnerGraph, true, "the graph flag reaches the architect.send path");
    assert.equal(send.text, "Build a roadmap from the topics in my knowledge graph.");
    assert.equal(names.filter((name) => name === "architect.send").length, 1, "one send, carrying the flag");
  } finally {
    fixture.controller.abort();
  }
});

test("'New roadmap' does not send the graph flag", async () => {
  const fixture = createViewFixture({ paths: [], graphTopics: 2 });
  try {
    await mountEmpty(fixture);
    const newButton = [...fixture.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "New roadmap",
    );
    assert.ok(newButton, "the toolbar offers New roadmap");
    newButton.click();
    for (let i = 0; i < 4; i += 1) await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "architect.send").length, 0, "New roadmap only opens a draft");
  } finally {
    fixture.controller.abort();
  }
});

test("the graph count is the brief's topic count", () => {
  const topic = (id: string) => ({
    id,
    name: `Topic ${id}`,
    statement: "A studied claim.",
    aliases: [],
    provenance: [{ chatId: "chat-a" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const empty = { propositions: [], chains: [] } as unknown as BriefGraph;
  assert.equal(readGraphTopicCount({ graph: () => empty }), 0);
  const graph = { propositions: [topic("a"), topic("b")], chains: [] } as unknown as BriefGraph;
  assert.equal(readGraphTopicCount({ graph: () => graph }), 2);
});

test("every graph-empty string exists in both English and Russian", () => {
  const source = fs.readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const enBlock = source.slice(source.indexOf("const en = {"), source.indexOf("export type MessageKey"));
  const ruBlock = source.slice(source.indexOf("const ru:"), source.indexOf("const tables"));
  const keys = (block: string) => [...block.matchAll(/^\s+"(graphEmpty\.[\w.]+)":\s*"[^"]+"/gm)].map((match) => match[1]);
  const enKeys = keys(enBlock);
  assert.deepEqual(enKeys, ["graphEmpty.build", "graphEmpty.hint", "graphEmpty.prompt"]);
  assert.deepEqual(keys(ruBlock), enKeys);
});
