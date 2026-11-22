/** Architect timing log: step lines, write failures, the size cap and privacy. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { buildArchitectDefinition } from "../src/architect-agent.ts";
import { createPluginLog, architectLogPath, ARCHITECT_LOG_FILE, LOG_DIRECTORY } from "../src/plugin-log.ts";
import { openLearningPathStore } from "../src/store.ts";
import type { ArchitectModelConfig } from "../src/store.ts";

type Line = Record<string, unknown>;

function workspace(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "architect-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readLines(file: string): Line[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line);
}

/** Capture console.warn so failed writes are asserted, not printed. */
function captureWarnings(t: { after: (fn: () => void) => void }): string[] {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

test("the log lives under <data>/logs/architect.jsonl", () => {
  assert.equal(architectLogPath("/data/plugin"), path.join("/data/plugin", LOG_DIRECTORY, ARCHITECT_LOG_FILE));
});

test("a step writes a start line and an end line with durationMs and ids only", (t) => {
  const file = path.join(workspace(t), LOG_DIRECTORY, ARCHITECT_LOG_FILE);
  let now = 1000;
  const log = createPluginLog(file, { clock: () => now });

  const step = log.begin("model call", { chatId: "chat-1", provider: "anthropic", model: "claude-haiku-5-5" });
  now += 1234.6;
  step.end({ inputTokens: 120, outputTokens: 40, status: "idle" });

  const lines = readLines(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.event, "step.start");
  assert.equal(lines[0]?.step, "model call");
  assert.equal(lines[0]?.provider, "anthropic");
  assert.equal(lines[0]?.model, "claude-haiku-5-5");
  assert.equal(lines[1]?.event, "step.end");
  assert.equal(lines[1]?.step, "model call");
  assert.equal(lines[1]?.durationMs, 1235);
  assert.equal(lines[1]?.ok, true);
  assert.equal(lines[1]?.inputTokens, 120);
  assert.equal(lines[1]?.outputTokens, 40);
  assert.equal(typeof lines[0]?.ts, "string");
});

test("a failed step writes ok: false with the error class name only, and ends once", (t) => {
  const file = path.join(workspace(t), ARCHITECT_LOG_FILE);
  let now = 0;
  const log = createPluginLog(file, { clock: () => now });
  const step = log.begin("save");
  now = 7;
  step.fail(new RangeError("boom with a message"));
  step.end();

  const lines = readLines(file);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]?.ok, false);
  assert.equal(lines[1]?.error, "RangeError");
  assert.equal(lines[1]?.durationMs, 7);
  assert.equal(JSON.stringify(lines).includes("boom with a message"), false);
});

test("a failing write does not throw and warns instead", (t) => {
  const dir = workspace(t);
  const blocker = path.join(dir, LOG_DIRECTORY);
  // A regular file where the logs folder should be makes every write fail.
  fs.writeFileSync(blocker, "not a directory");
  const warnings = captureWarnings(t);
  const log = createPluginLog(path.join(blocker, ARCHITECT_LOG_FILE));

  assert.doesNotThrow(() => {
    log.event("architect.state", { status: "idle" });
    const step = log.begin("draft");
    step.end({ outcome: "accepted" });
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0] ?? "", /could not write the Architect log/);
});

test("the size cap keeps only the newest half of the lines", (t) => {
  const file = path.join(workspace(t), ARCHITECT_LOG_FILE);
  const maxBytes = 2000;
  const log = createPluginLog(file, { maxBytes });

  for (let index = 0; index < 60; index += 1) {
    log.event("tick", { n: index });
  }

  assert.ok(fs.statSync(file).size <= maxBytes, "file stays within the cap");
  const numbers = readLines(file).map((line) => line.n as number);
  assert.ok(numbers.length > 0 && numbers.length < 60, "older lines were dropped");
  // The survivors are the newest, in order, ending with the last write.
  assert.equal(numbers.at(-1), 59);
  for (let index = 1; index < numbers.length; index += 1) {
    assert.equal(numbers[index], (numbers[index - 1] as number) + 1);
  }
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("test output carries no learner text", (t) => {
  const file = path.join(workspace(t), ARCHITECT_LOG_FILE);
  const warnings = captureWarnings(t);
  const log = createPluginLog(file);
  // Only counts, ids and timings are passed by the Architect; this checks the line shape.
  const step = log.begin("draft", { tool: "save_learning_path", modules: 2, nodes: 9 });
  step.end({ outcome: "accepted" });
  const written = fs.readFileSync(file, "utf8");
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    readLines(file).map((line) => line.event),
    ["step.start", "step.end"],
  );
  assert.equal(written.includes("goal"), false);
  assert.equal(written.includes("statement"), false);
});

test("a rejected save writes a draft step ending with ok false, without the draft content", async (t) => {
  const dir = workspace(t);
  const store = openLearningPathStore(dir);
  const ctx = { signal: new AbortController().signal } as unknown as PluginBackendContext;
  const model = { provider: "anthropic", id: "claude-haiku-5-5" } as ArchitectModelConfig;
  const definition = buildArchitectDefinition(ctx, model, {
    store,
    activeChatId: () => "chat-1",
    log: createPluginLog(architectLogPath(dir)),
    // Upstream is the only mode; the rejected save never fetches.
    upstream: { fetch: async () => { throw new Error("no fetch expected"); }, commit: "0123456789abcdef0123456789abcdef01234567" },
  });
  const save = definition.tools?.find((tool) => tool.name === "save_learning_path");
  assert.ok(save && save.kind !== "input" && save.execute);
  // No modules and no sourceSpine: rejected before anything is written.
  const result = await save.execute("call-1", { title: "Learner goal text", goal: "Learner goal text" }, undefined);

  assert.equal(result.isError, true);
  const lines = readLines(architectLogPath(dir));
  assert.deepEqual(lines.map((line) => line.event), ["step.start", "step.end"]);
  assert.equal(lines[0]?.step, "draft");
  assert.equal(lines[1]?.ok, false);
  assert.equal(lines[1]?.outcome, "rejected");
  assert.equal(JSON.stringify(lines).includes("Learner goal text"), false);
  assert.equal(store.paths().length, 0);
});
