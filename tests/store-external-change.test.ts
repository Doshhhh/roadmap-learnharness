/** Roadmap files changed on disk by another writer (for example a Git pull) are reloaded or refused, never overwritten. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROADMAPS_DIRECTORY,
  ROADMAP_INDEX_FILE,
  STORE_SCHEMA_VERSION,
  StoreError,
  openLearningPathStore,
  roadmapFileName,
} from "../src/store.ts";
import { clone, makePath } from "./fixtures.ts";

const ID = "path-linear-algebra";

function directory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-external-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const roadmapFile = (dir: string, id: string = ID): string => path.join(dir, ROADMAPS_DIRECTORY, roadmapFileName(id));
const indexFile = (dir: string): string => path.join(dir, ROADMAP_INDEX_FILE);
const read = (filename: string): string => fs.readFileSync(filename, "utf8");
const envelope = (title: string, revision: number): string =>
  `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision, roadmap: { ...clone(makePath()), title } }, null, 2)}\n`;
const titled = (title: string) => ({ ...clone(makePath()), title });

test("an external change is reloaded and replaces the in-memory copy", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());

  // Another writer (a Git pull) changes the file while the store is open.
  const external = envelope("Edited in Git", 7);
  fs.writeFileSync(roadmapFile(dir), external);

  assert.throws(
    () => store.savePath(titled("Overwrite attempt")),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "stale" &&
      /reloaded from disk/.test(error.message) &&
      /NOT saved/.test(error.message),
  );
  // The in-memory copy now matches disk, and the external bytes were not touched.
  assert.equal(store.path(ID)?.title, "Edited in Git");
  assert.equal(read(roadmapFile(dir)), external);

  // Saving again on top of the reloaded copy works and continues from the on-disk revision.
  store.savePath(titled("Saved after reload"));
  const saved = JSON.parse(read(roadmapFile(dir)));
  assert.equal(saved.roadmap.title, "Saved after reload");
  assert.equal(saved.revision, 8);
});

test("a stale save is refused rather than overwriting the external change", (t) => {
  const dir = directory(t);
  const first = openLearningPathStore(dir);
  first.savePath(makePath());

  // A second store on the same folder (another session) saves a newer version first.
  const second = openLearningPathStore(dir);
  second.savePath(titled("Saved by the other session"));
  const onDisk = read(roadmapFile(dir));

  assert.throws(
    () => first.savePath(titled("Stale title")),
    (error: unknown) => error instanceof StoreError && error.code === "stale",
  );
  assert.equal(read(roadmapFile(dir)), onDisk);
  assert.equal(first.path(ID)?.title, "Saved by the other session");

  // Deleting a roadmap that changed on disk after the last read is refused the same way.
  second.savePath(titled("Changed again by the other session"));
  const changedAgain = read(roadmapFile(dir));
  assert.throws(() => first.deletePath(ID), (error: unknown) => error instanceof StoreError && error.code === "stale");
  assert.equal(read(roadmapFile(dir)), changedAgain);
  assert.equal(openLearningPathStore(dir).path(ID)?.title, "Changed again by the other session");
});

test("an invalid file after an external change is refused with a message that names it and no write happens", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const index = read(indexFile(dir));

  // A Git merge left conflict markers in the roadmap file.
  const conflicted = [
    "<<<<<<< HEAD",
    envelope("Local title", 2).trimEnd(),
    "=======",
    envelope("Remote title", 2).trimEnd(),
    ">>>>>>> origin/main",
    "",
  ].join("\n");
  fs.writeFileSync(roadmapFile(dir), conflicted);

  const messages: string[] = [];
  for (const attempt of [
    () => store.savePath(titled("Overwrite attempt")),
    () => store.savePath(titled("Second attempt")),
    () => store.deletePath(ID),
  ]) {
    assert.throws(attempt, (error: unknown) => {
      if (!(error instanceof StoreError) || error.code !== "corrupt") return false;
      messages.push(error.message);
      return true;
    });
  }
  for (const message of messages) {
    assert.match(message, new RegExp(roadmapFile(dir).replaceAll(".", "\\.")));
    assert.match(message, /Resolve it in the Git view/);
  }
  assert.equal(read(roadmapFile(dir)), conflicted);
  assert.equal(read(indexFile(dir)), index);
  assert.equal(store.path(ID), null);
  assert.equal(store.refusals()[0]?.id, ID);
  assert.equal(store.refusals()[0]?.code, "corrupt");
});

test("an invalid roadmap index after an external change blocks every write", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const brokenIndex = "{ not json";
  fs.writeFileSync(indexFile(dir), brokenIndex);
  const roadmap = read(roadmapFile(dir));

  assert.throws(
    () => store.savePath({ ...clone(makePath()), id: "path-2", title: "Second" }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "corrupt" &&
      new RegExp(indexFile(dir).replaceAll(".", "\\.")).test(error.message) &&
      /Resolve it in the Git view/.test(error.message),
  );
  assert.throws(() => store.savePath(titled("Blocked")), StoreError);
  assert.equal(read(indexFile(dir)), brokenIndex);
  assert.equal(read(roadmapFile(dir)), roadmap);
});

test("a newer roadmap file that appears after open is refused and never overwritten", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const newer = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 4, roadmap: makePath() }, null, 2)}\n`;
  fs.writeFileSync(roadmapFile(dir), newer);

  assert.throws(
    () => store.savePath(titled("Overwrite attempt")),
    (error: unknown) =>
      error instanceof StoreError && error.code === "newer-schema" && /newer schema version 2/.test(error.message),
  );
  assert.throws(() => store.deletePath(ID), (error: unknown) => error instanceof StoreError && error.code === "newer-schema");
  assert.equal(read(roadmapFile(dir)), newer);
  assert.equal(store.refusals()[0]?.code, "newer-schema");
});

test("a roadmap file removed on disk is dropped from memory and never recreated by a save", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());

  // A Git pull (or the learner) removes the file on purpose while the store is open.
  fs.rmSync(roadmapFile(dir));

  assert.throws(
    () => store.savePath(titled("Edited from stale memory")),
    (error: unknown) => error instanceof StoreError && error.code === "stale" && error.message.includes(roadmapFile(dir)),
  );
  assert.equal(fs.existsSync(roadmapFile(dir)), false, "the removed file is not recreated");
  assert.equal(store.path(ID), null);
  assert.deepEqual(store.refusals(), []);
});
