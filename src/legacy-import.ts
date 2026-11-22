/** One-time import from the Learning Paths plugin this project was forked from.
 *
 * Roadmap stores data under its own plugin id, so a learner who used Learning
 * Paths would otherwise start empty. On first activation, when Roadmap has no
 * paths file yet and a sibling `learning-path/data/learning-paths.json` exists,
 * the legacy records are COPIED (never moved or modified): paths, settings,
 * the Architect conversation index, converted sources and Architect agent
 * transcripts. A marker file prevents a second import after the learner deletes
 * everything on purpose.
 */
import fs from "node:fs";
import path from "node:path";
import { hasRoadmapData } from "./store.ts";

export const LEGACY_PLUGIN_ID = "learning-path";
export const IMPORT_MARKER = "imported-from-learning-path.json";
const FILES = ["learning-paths.json", "settings.json", "architect.json"] as const;
const DIRECTORIES = ["sources", "agents"] as const;

export interface LegacyImportResult {
  readonly imported: boolean;
  readonly reason: "imported" | "already-has-data" | "already-imported" | "no-legacy-data";
  readonly copied: readonly string[];
}

function isFile(filename: string): boolean {
  return fs.lstatSync(filename, { throwIfNoEntry: false })?.isFile() === true;
}

function isDirectory(filename: string): boolean {
  return fs.lstatSync(filename, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Copy a directory tree, refusing symlinks so nothing outside the data folder is followed. */
function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile() && !fs.existsSync(target)) fs.copyFileSync(source, target);
  }
}

/** `dataDirectory` is this plugin's `<plugins>/<id>/data`; the legacy one is its sibling plugin's. */
export function legacyDataDirectory(dataDirectory: string): string {
  return path.join(path.dirname(path.dirname(dataDirectory)), LEGACY_PLUGIN_ID, "data");
}

export function importLegacyData(dataDirectory: string, now: () => Date = () => new Date()): LegacyImportResult {
  if (isFile(path.join(dataDirectory, IMPORT_MARKER))) return { imported: false, reason: "already-imported", copied: [] };
  if (hasRoadmapData(dataDirectory) || isFile(path.join(dataDirectory, FILES[0]))) {
    return { imported: false, reason: "already-has-data", copied: [] };
  }
  const legacy = legacyDataDirectory(dataDirectory);
  if (!isFile(path.join(legacy, FILES[0]))) return { imported: false, reason: "no-legacy-data", copied: [] };

  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  // Supporting records first; the paths file last, so a crash mid-way retries next time.
  for (const name of DIRECTORIES) {
    const source = path.join(legacy, name);
    if (!isDirectory(source)) continue;
    copyTree(source, path.join(dataDirectory, name));
    copied.push(`${name}/`);
  }
  for (const name of [...FILES.slice(1), FILES[0]]) {
    const source = path.join(legacy, name);
    const target = path.join(dataDirectory, name);
    if (!isFile(source) || fs.existsSync(target)) continue;
    const temporary = `${target}.import-${process.pid}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, target);
    copied.push(name);
  }
  fs.writeFileSync(
    path.join(dataDirectory, IMPORT_MARKER),
    `${JSON.stringify({ from: LEGACY_PLUGIN_ID, at: now().toISOString(), copied }, null, 2)}\n`,
  );
  return { imported: true, reason: "imported", copied };
}
