/** Tests for the one-time import from the fork's previous plugin id (`roadmap`). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FORK_IMPORT_MARKER, forkDataDirectory, importForkData } from "../src/fork-import.ts";
import { makePath } from "./fixtures.ts";

function temporary(t: { after(fn: () => void): void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-fork-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Every file below `directory` with its bytes, so a test can prove nothing changed. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(directory)) return files;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(directory, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(directory);
  return files;
}

const pathsFile = (paths: unknown[] = [makePath()]) => JSON.stringify({ schemaVersion: 1, revision: 2, paths });
const architectFile = () =>
  JSON.stringify({ schemaVersion: 1, revision: 1, model: { provider: "openai", id: "gpt-test", thinkingLevel: "low" } });

function setup(t: { after(fn: () => void): void }) {
  const plugins = temporary(t);
  const own = path.join(plugins, "roadmap-learnharness", "data");
  const old = forkDataDirectory(own);
  fs.mkdirSync(old, { recursive: true });
  return { own, old };
}

test("fork data is copied once, the old folder is never changed, and the marker stops a second import", (t) => {
  const { own, old } = setup(t);
  fs.writeFileSync(path.join(old, "learning-paths.json"), pathsFile());
  fs.writeFileSync(path.join(old, "architect.json"), architectFile());
  const before = snapshot(old);

  const result = importForkData(own, () => new Date("2026-11-22T10:00:00.000Z"));
  assert.equal(result.reason, "imported");
  assert.deepEqual([...result.copied].sort(), ["architect.json", "learning-paths.json"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(path.join(own, "learning-paths.json"), "utf8"), pathsFile());
  assert.equal(fs.readFileSync(path.join(own, "architect.json"), "utf8"), architectFile());
  assert.ok(fs.existsSync(path.join(own, FORK_IMPORT_MARKER)));
  assert.deepEqual(snapshot(old), before, "the old folder is unchanged");

  // Deleting the data on purpose must not bring it back.
  fs.rmSync(path.join(own, "learning-paths.json"));
  assert.equal(importForkData(own).reason, "already-imported");
  assert.equal(fs.existsSync(path.join(own, "learning-paths.json")), false);
  assert.deepEqual(snapshot(old), before);
});

test("foreign data in the old folder is skipped and never copied", (t) => {
  const { own, old } = setup(t);
  // 808arc/roadmap keeps its own files here; none of them is this fork's schema.
  fs.mkdirSync(path.join(old, "state"), { recursive: true });
  fs.writeFileSync(path.join(old, "state", "session.json"), '{"foreign":true}');
  fs.writeFileSync(path.join(old, "usage.jsonl"), "{}\n");
  fs.writeFileSync(path.join(old, "learning-paths.json"), JSON.stringify({ schemaVersion: 1, revision: 1, paths: "nope" }));
  const before = snapshot(old);

  const result = importForkData(own);
  assert.equal(result.reason, "no-fork-data");
  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.skipped, ["learning-paths.json"]);
  assert.equal(fs.existsSync(own), false, "nothing is created in the new folder");
  assert.equal(fs.existsSync(path.join(own, FORK_IMPORT_MARKER)), false);
  assert.deepEqual(snapshot(old), before);
});

test("a foreign file is skipped while this fork's file next to it is still imported", (t) => {
  const { own, old } = setup(t);
  fs.writeFileSync(path.join(old, "learning-paths.json"), JSON.stringify({ schemaVersion: 9, revision: 1, paths: [] }));
  fs.writeFileSync(path.join(old, "architect.json"), architectFile());

  const result = importForkData(own);
  assert.equal(result.reason, "imported");
  assert.deepEqual(result.copied, ["architect.json"]);
  assert.deepEqual(result.skipped, ["learning-paths.json"]);
  assert.equal(fs.existsSync(path.join(own, "learning-paths.json")), false);
});

test("a corrupt file refuses the whole import: nothing is copied and no marker is written", (t) => {
  const { own, old } = setup(t);
  fs.writeFileSync(path.join(old, "architect.json"), architectFile());
  fs.writeFileSync(path.join(old, "learning-paths.json"), "{ not json");
  const before = snapshot(old);

  assert.throws(() => importForkData(own), /corrupt/);
  assert.equal(fs.existsSync(own), false, "the new folder is not created");
  assert.deepEqual(snapshot(old), before, "the old folder is unchanged");

  // Once the file is repaired the import runs.
  fs.writeFileSync(path.join(old, "learning-paths.json"), pathsFile());
  assert.equal(importForkData(own).reason, "imported");
});

test("existing Roadmap data is never overwritten", (t) => {
  const { own, old } = setup(t);
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(old, "learning-paths.json"), pathsFile());
  fs.writeFileSync(path.join(own, "learning-paths.json"), "mine");

  assert.equal(importForkData(own).reason, "already-has-data");
  assert.equal(fs.readFileSync(path.join(own, "learning-paths.json"), "utf8"), "mine");
  assert.equal(fs.existsSync(path.join(own, FORK_IMPORT_MARKER)), false);
});
