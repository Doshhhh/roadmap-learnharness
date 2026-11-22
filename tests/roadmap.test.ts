/** Tests for the Roadmap additions: layout, progress counting, node marks,
 * legacy import, session metrics and translations. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLearningPath, parsePluginSettings } from "../src/domain.ts";
import type { LearningPath, PathModule, PathNode } from "../src/domain.ts";
import { resolveLocale, setLocale, t } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import { IMPORT_MARKER, importLegacyData, legacyDataDirectory } from "../src/legacy-import.ts";
import { DEFAULT_BREAK_MS, sessionMetrics } from "../src/session-metrics.ts";
import {
  PAD_BOTTOM,
  SUB_H,
  defaultExpandedModule,
  layoutRoadmap,
  moduleCounts,
  nodeRole,
  progressCounts,
} from "../src/view/roadmap-layout.ts";
import { makeNode, makePath, rawPath } from "./fixtures.ts";

const alternatives = (): PathNode[] => [
  makeNode("gcc", "skill", { alternativeGroup: "compiler", progression: "consolidated" }),
  makeNode("clang", "skill", { alternativeGroup: "compiler", progression: "skipped" }),
];

test("progress counts required work: optional nodes are excluded, an alternative group counts once", () => {
  const nodes = [
    makeNode("a", "concept", { progression: "consolidated" }),
    makeNode("b", "concept", { progression: "skipped" }),
    makeNode("c", "concept", { progression: "in_progress" }),
    makeNode("opt", "bridge", { optional: true, progression: "unstarted" }),
    ...alternatives(),
  ];
  assert.deepEqual(progressCounts(nodes), { done: 3, total: 4 });
  // A group where nobody is consolidated stays open even if a member is skipped.
  const open = progressCounts([makeNode("x", "skill", { alternativeGroup: "g", progression: "skipped" })]);
  assert.deepEqual(open, { done: 0, total: 1 });
});

test("node roles split an expanded module into order, additional and consolidation", () => {
  assert.equal(nodeRole(makeNode("a", "concept")), "order");
  assert.equal(nodeRole(makeNode("b", "concept", { optional: true })), "extra");
  assert.equal(nodeRole(makeNode("c", "skill", { alternativeGroup: "g" })), "extra");
  assert.equal(nodeRole(makeNode("d", "checkpoint")), "consolidation");
});

test("the layout stacks module frames bottom-up and places each node in its dependency column", () => {
  const path = makePath();
  const layout = layoutRoadmap(path, { expandedModuleId: "module-synthesis", showOptional: true });

  const [first, second] = layout.modules;
  assert.equal(first!.module.id, "module-structure");
  assert.equal(second!.expanded, true);
  assert.ok(second!.y + second!.h < first!.y, "the later module is drawn above the earlier one");
  assert.ok(layout.height - (first!.y + first!.h) >= PAD_BOTTOM, "space under the first module for zoom and legend");

  // Module order is the fallback prerequisite chain: holistic, concept, skill, contrast, checkpoint, bridge.
  const depth = (id: string): number => layout.nodes.find((placed) => placed.node.id === id)!.depth;
  assert.deepEqual(
    ["n-holistic", "n-concept", "n-skill", "n-contrast", "n-checkpoint", "n-bridge"].map(depth),
    [0, 1, 2, 3, 4, 5],
  );
  const holistic = layout.nodes.find((placed) => placed.node.id === "n-holistic")!;
  const bridge = layout.nodes.find((placed) => placed.node.id === "n-bridge")!;
  assert.ok(bridge.x > holistic.x, "deeper nodes sit further right");

  // Every node sits inside its module's frame.
  for (const placed of layout.nodes) {
    const frame = layout.modules.find((entry) => entry.module.id === placed.moduleId)!;
    assert.ok(placed.y >= frame.y && placed.y + SUB_H <= frame.y + frame.h, `${placed.node.id} is inside its frame`);
    assert.ok(placed.x >= frame.x && placed.x + placed.w <= frame.x + frame.w, `${placed.node.id} is inside its frame sideways`);
  }
});

test("every prerequisite gets one arrow to each dependent node, pointing forward", () => {
  const layout = layoutRoadmap(makePath(), { expandedModuleId: null, showOptional: true });
  assert.equal(layout.edges.length, 5, "a chain of six nodes has five arrows");
  for (const edge of layout.edges) {
    assert.ok(edge.x1 < edge.x2, `arrow ${edge.from} -> ${edge.to} points right`);
    const from = layout.nodes.find((placed) => placed.node.id === edge.from)!;
    const to = layout.nodes.find((placed) => placed.node.id === edge.to)!;
    assert.equal(edge.x1, from.x + from.w);
    assert.equal(edge.x2, to.x);
  }
});

test("optional nodes can be hidden; shown optional nodes have dashed arrows, and hiding one reconnects its neighbours", () => {
  const path = makePath();
  const nodes = path.modules[0]!.nodes.map((node) => (node.id === "n-skill" ? { ...node, optional: true } : node));
  (path.modules as PathModule[])[0] = { ...path.modules[0]!, nodes };
  const shown = layoutRoadmap(path, { expandedModuleId: null, showOptional: true });
  assert.ok(shown.nodes.some((placed) => placed.node.id === "n-skill"));
  assert.equal(shown.edges.filter((edge) => edge.dashed).length, 2, "the two arrows into and out of the optional node");
  const hidden = layoutRoadmap(path, { expandedModuleId: null, showOptional: false });
  assert.ok(!hidden.nodes.some((placed) => placed.node.id === "n-skill"));
  assert.ok(hidden.edges.some((edge) => edge.from === "n-concept" && edge.to === "n-contrast" && !edge.dashed));
  assert.equal(hidden.edges.filter((edge) => edge.dashed).length, 0);
});

test("the expanded module defaults to the selected node's, else the first unfinished one", () => {
  const path = makePath();
  assert.equal(defaultExpandedModule(path, "n-bridge"), "module-synthesis");
  assert.equal(defaultExpandedModule(path, null), "module-structure");
  const done: LearningPath = {
    ...path,
    modules: path.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) => ({ ...node, progression: "consolidated" as const })),
    })),
  };
  assert.equal(defaultExpandedModule(done, null), "module-synthesis", "a finished roadmap opens at its end");
  assert.deepEqual(moduleCounts(done.modules[0]!), { done: 3, total: 3 });
});

test("node marks, outcomes and resources validate, and bad links are refused", () => {
  const value = rawPath();
  value.modules[0].nodes[0] = {
    ...value.modules[0].nodes[0],
    optional: true,
    alternativeGroup: "",
    outcomes: ["Explain the map", "Explain the map", "Draw it from memory"],
    resources: [
      { title: "Course", kind: "course", url: "https://example.org/course", free: true },
      { title: "Book chapter", kind: "book" },
    ],
  };
  const parsed = parseLearningPath(value).modules[0]!.nodes[0]!;
  assert.equal(parsed.optional, true);
  assert.equal(parsed.alternativeGroup, undefined, "an empty group is no group");
  assert.deepEqual(parsed.outcomes, ["Explain the map", "Draw it from memory"], "duplicate outcomes collapse");
  assert.deepEqual(parsed.resources, [
    { title: "Course", kind: "course", url: "https://example.org/course", free: true },
    { title: "Book chapter", kind: "book" },
  ]);

  value.modules[0].nodes[0].resources = [{ title: "Script", kind: "article", url: "javascript:alert(1)" }];
  assert.throws(() => parseLearningPath(value), /must be an http\(s\) address/);
  value.modules[0].nodes[0].resources = [{ title: "Podcast", kind: "podcast" }];
  assert.throws(() => parseLearningPath(value), /kind: must be one of/);
});

test("display settings default sensibly and reject unknown values", () => {
  assert.deepEqual(parsePluginSettings({ artifactDefaults: {} }), { artifactDefaults: {} });
  const parsed = parsePluginSettings({ artifactDefaults: {}, display: { language: "ru" }, contentLanguage: "en" });
  assert.deepEqual(parsed.display, { language: "ru", defaultView: "graph", showOptional: true, patternHints: true });
  assert.equal(parsed.contentLanguage, "en");
  assert.throws(() => parsePluginSettings({ artifactDefaults: {}, display: { defaultView: "kanban" } }));
});

function temporary(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("legacy Learning Paths data is copied once and never modified", (t) => {
  const plugins = temporary(t);
  const legacy = path.join(plugins, "learning-path", "data");
  const own = path.join(plugins, "roadmap-learnharness", "data");
  assert.equal(legacyDataDirectory(own), legacy);

  assert.equal(importLegacyData(own).reason, "no-legacy-data");
  fs.mkdirSync(path.join(legacy, "sources"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "agents", "conv-1"), { recursive: true });
  const paths = JSON.stringify({ schemaVersion: 1, revision: 3, paths: [] });
  fs.writeFileSync(path.join(legacy, "learning-paths.json"), paths);
  fs.writeFileSync(path.join(legacy, "settings.json"), '{"schemaVersion":1,"revision":1,"settings":{"artifactDefaults":{}}}');
  fs.writeFileSync(path.join(legacy, "sources", "book.md"), "# Book");
  fs.writeFileSync(path.join(legacy, "agents", "conv-1", "messages.jsonl"), "{}\n");

  const result = importLegacyData(own, () => new Date("2026-11-16T12:00:00.000Z"));
  assert.equal(result.reason, "imported");
  assert.deepEqual([...result.copied].sort(), ["agents/", "learning-paths.json", "settings.json", "sources/"]);
  assert.equal(fs.readFileSync(path.join(own, "learning-paths.json"), "utf8"), paths);
  assert.equal(fs.readFileSync(path.join(own, "sources", "book.md"), "utf8"), "# Book");
  assert.ok(fs.existsSync(path.join(own, "agents", "conv-1", "messages.jsonl")));
  assert.ok(fs.existsSync(path.join(own, IMPORT_MARKER)));
  assert.equal(fs.readFileSync(path.join(legacy, "learning-paths.json"), "utf8"), paths, "the legacy file is untouched");

  // Deleting everything on purpose must not bring the old data back.
  fs.rmSync(path.join(own, "learning-paths.json"));
  assert.equal(importLegacyData(own).reason, "already-imported");
  assert.equal(fs.existsSync(path.join(own, "learning-paths.json")), false);
});

test("legacy import does nothing when Roadmap already has data", (t) => {
  const plugins = temporary(t);
  const legacy = path.join(plugins, "learning-path", "data");
  const own = path.join(plugins, "roadmap-learnharness", "data");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(legacy, "learning-paths.json"), "legacy");
  fs.writeFileSync(path.join(own, "learning-paths.json"), "mine");
  assert.equal(importLegacyData(own).reason, "already-has-data");
  assert.equal(fs.readFileSync(path.join(own, "learning-paths.json"), "utf8"), "mine");
});

test("session metrics sum focused time between learner actions and skip breaks", () => {
  const minute = 60_000;
  const at = (minutes: number) => Date.UTC(2026, 10, 12, 18, 0) + minutes * minute;
  const answered = (minutes: number, extra: Record<string, unknown>) => ({
    role: "toolResult",
    timestamp: at(minutes) + 999,
    details: { answeredAt: new Date(at(minutes)).toISOString(), ...extra },
  });
  const metrics = sessionMetrics([
    { role: "user", timestamp: at(0) },
    { role: "assistant", timestamp: at(1) },
    answered(4, { correct: true }),
    answered(9, { correct: false }),
    answered(12, { dontKnow: true }),
    { role: "custom", customType: "practice-thinking", timestamp: at(14) },
    answered(16, { correct: true, dismissed: true }),
    { role: "user", timestamp: at(60) },
    { role: "user", timestamp: at(62) },
  ]);
  assert.equal(metrics.startedAt, at(0));
  assert.equal(metrics.focusedMs, (14 + 2) * minute, "the 46-minute break is not study time");
  assert.equal(metrics.answered, 3);
  assert.equal(metrics.correct, 1);
  assert.equal(DEFAULT_BREAK_MS, 15 * minute);
  assert.deepEqual(sessionMetrics([]), { startedAt: null, focusedMs: 0, answered: 0, correct: 0 });
});

test("every interface string exists in both languages and the locale follows the setting", () => {
  assert.equal(resolveLocale("ru", "en-US"), "ru");
  assert.equal(resolveLocale("auto", "ru-RU"), "ru");
  assert.equal(resolveLocale("auto", "de-DE"), "en");
  const source = fs.readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const ruBlock = source.slice(source.indexOf("const ru:"), source.indexOf("const tables"));
  const enBlock = source.slice(source.indexOf("const en = {"), source.indexOf("export type MessageKey"));
  const keys = (block: string) => [...block.matchAll(/^\s+"([\w.]+)":/gm)].map((match) => match[1]);
  assert.deepEqual(keys(ruBlock).sort(), keys(enBlock).sort());
  setLocale("ru");
  assert.equal(t("foot.summary" as MessageKey, { done: 7, total: 14, progress: 2 }), "пройдено 7 из 14 · в работе 2");
  setLocale("en");
  assert.equal(t("foot.summary" as MessageKey, { done: 7, total: 14, progress: 2 }), "consolidated 7 of 14 · in progress 2");
});
