/** The one-time importers must stay off once Roadmap data exists in any layout, split or migrated. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forkDataDirectory, importForkData } from "../src/fork-import.ts";
import { importLegacyData, legacyDataDirectory } from "../src/legacy-import.ts";
import { LEARNING_PATHS_FILE, openLearningPathStore, STORE_SCHEMA_VERSION } from "../src/store.ts";
import { makePath } from "./fixtures.ts";

function layout(t: { after(fn: () => void): void }): { own: string; legacy: string; fork: string } {
  const plugins = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-import-split-"));
  t.after(() => fs.rmSync(plugins, { recursive: true, force: true }));
  const own = path.join(plugins, "roadmap-learnharness", "data");
  const legacy = legacyDataDirectory(own);
  const fork = forkDataDirectory(own);
  assert.equal(path.dirname(path.dirname(legacy)), plugins);
  assert.equal(path.dirname(path.dirname(fork)), plugins);
  return { own, legacy, fork };
}

/** Old-schema data in a sibling plugin's folder, so an importer would have something to copy. */
function siblingData(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const text = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 1, paths: [makePath()] });
  fs.writeFileSync(path.join(directory, LEARNING_PATHS_FILE), text);
}

/** Every entry below `directory`, sorted, so a test can prove nothing was copied in. */
function entries(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      found.push(path.relative(directory, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(directory);
  return found.sort();
}

test("after the split, a second start copies nothing from the sibling plugins", (t) => {
  const { own, legacy, fork } = layout(t);
  siblingData(legacy);
  siblingData(fork);
  // First start: the learner's own legacy file is migrated into the split layout.
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, LEARNING_PATHS_FILE), JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 1, paths: [makePath()] }));
  openLearningPathStore(own);
  const before = entries(own);
  assert.ok(before.includes("roadmaps-index.json"));
  assert.ok(before.includes(`${LEARNING_PATHS_FILE}.migrated`));

  // Second start: the file under the old name is gone, but the importers must still stay off.
  assert.equal(importForkData(own).reason, "already-has-data");
  assert.equal(importForkData(own).imported, false);
  const legacyResult = importLegacyData(own);
  assert.equal(legacyResult.imported, false);
  assert.equal(legacyResult.reason, "already-has-data");
  assert.deepEqual(legacyResult.copied, []);
  assert.deepEqual(entries(own), before, "nothing new was copied into the data folder");
  assert.equal(fs.existsSync(path.join(own, LEARNING_PATHS_FILE)), false);
});

test("a fresh data folder with no data still imports from the sibling plugins", (t) => {
  const { own, legacy, fork } = layout(t);
  siblingData(legacy);
  siblingData(fork);
  const legacyResult = importLegacyData(own);
  assert.equal(legacyResult.reason, "imported");
  assert.equal(fs.existsSync(path.join(own, LEARNING_PATHS_FILE)), true);
  const forkResult = importForkData(own);
  assert.equal(forkResult.reason, "already-has-data", "the legacy import has already put data in place");
});

test("a fresh folder imports from the fork's previous plugin id on its own", (t) => {
  const { own, fork } = layout(t);
  siblingData(fork);
  const result = importForkData(own);
  assert.equal(result.reason, "imported");
  assert.deepEqual(result.copied, [LEARNING_PATHS_FILE]);
});

test("a folder holding only learning-paths.json.migrated does not import", (t) => {
  const { own, legacy, fork } = layout(t);
  siblingData(legacy);
  siblingData(fork);
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, `${LEARNING_PATHS_FILE}.migrated`), "{}");
  const forkResult = importForkData(own);
  assert.equal(forkResult.imported, false);
  assert.equal(forkResult.reason, "already-has-data");
  const legacyResult = importLegacyData(own);
  assert.equal(legacyResult.imported, false);
  assert.equal(legacyResult.reason, "already-has-data");
  assert.deepEqual(entries(own), [`${LEARNING_PATHS_FILE}.migrated`]);
});
