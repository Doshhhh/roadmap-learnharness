/** One-time import from this fork's previous plugin id (`roadmap`).
 *
 * The plugin id changed to `roadmap-learnharness`, so a learner who used the
 * fork would otherwise start empty. On first activation, when the new data
 * folder holds no Roadmap file yet and the old `<plugins>/roadmap/data/` folder
 * holds `learning-paths.json` or `architect.json` in THIS fork's schema, those
 * files are COPIED (never moved or modified). Anything else in the old folder is
 * ignored: `state/`, `usage.jsonl` and other files may belong to a different
 * plugin (808arc/roadmap) that used the same folder name. Files that parse as
 * JSON but do not match the fork's schema are skipped and reported. Files that
 * are not valid JSON refuse the whole import, which then copies nothing and
 * writes no marker, so it is retried on the next start. A marker file prevents a
 * second import after the learner deletes everything on purpose.
 */
import fs from "node:fs";
import path from "node:path";
import { THINKING_LEVELS, validateLearningPath } from "./domain.ts";
import { ARCHITECT_FILE, LEARNING_PATHS_FILE, STORE_SCHEMA_VERSION, hasRoadmapData } from "./store.ts";

export const FORK_PREVIOUS_PLUGIN_ID = "roadmap";
export const FORK_IMPORT_MARKER = "imported-from-roadmap.json";
const FILES = [LEARNING_PATHS_FILE, ARCHITECT_FILE] as const;

export interface ForkImportResult {
  readonly imported: boolean;
  readonly reason: "imported" | "already-has-data" | "already-imported" | "no-fork-data";
  readonly copied: readonly string[];
  /** Present files that are not this fork's schema; they were not copied. */
  readonly skipped: readonly string[];
}

function isFile(filename: string): boolean {
  return fs.lstatSync(filename, { throwIfNoEntry: false })?.isFile() === true;
}

function exists(filename: string): boolean {
  return fs.lstatSync(filename, { throwIfNoEntry: false }) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True only when the parsed file has this fork's schema for that file name. */
export function matchesForkSchema(name: string, record: Record<string, unknown>): boolean {
  const revision = record.revision;
  if (record.schemaVersion !== STORE_SCHEMA_VERSION || !Number.isSafeInteger(revision) || (revision as number) < 0) return false;
  if (name === LEARNING_PATHS_FILE) {
    if (!Array.isArray(record.paths)) return false;
    const ids = new Set<string>();
    return record.paths.every((entry: unknown) => {
      const result = validateLearningPath(entry);
      if (!result.ok || ids.has(result.value.id)) return false;
      ids.add(result.value.id);
      return true;
    });
  }
  const model = record.model;
  return (
    isRecord(model) &&
    typeof model.provider === "string" &&
    model.provider.trim() !== "" &&
    typeof model.id === "string" &&
    model.id.trim() !== "" &&
    (model.thinkingLevel === undefined || (THINKING_LEVELS as readonly unknown[]).includes(model.thinkingLevel))
  );
}

/** `dataDirectory` is this plugin's `<plugins>/<id>/data`; the previous one is the fork's old id. */
export function forkDataDirectory(dataDirectory: string): string {
  return path.join(path.dirname(path.dirname(dataDirectory)), FORK_PREVIOUS_PLUGIN_ID, "data");
}

export function importForkData(dataDirectory: string, now: () => Date = () => new Date()): ForkImportResult {
  if (isFile(path.join(dataDirectory, FORK_IMPORT_MARKER))) return { imported: false, reason: "already-imported", copied: [], skipped: [] };
  if (hasRoadmapData(dataDirectory) || FILES.some((name) => exists(path.join(dataDirectory, name)))) {
    return { imported: false, reason: "already-has-data", copied: [], skipped: [] };
  }

  // Read and validate everything before writing anything, so a corrupt file copies nothing.
  const legacy = forkDataDirectory(dataDirectory);
  const staged: { name: string; bytes: Buffer }[] = [];
  const skipped: string[] = [];
  for (const name of FILES) {
    const source = path.join(legacy, name);
    if (!isFile(source)) continue;
    const bytes = fs.readFileSync(source);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Roadmap data at ${source} is corrupt (invalid JSON). Nothing was imported and the old folder was not changed.`);
    }
    if (isRecord(parsed) && matchesForkSchema(name, parsed)) staged.push({ name, bytes });
    else skipped.push(name);
  }
  if (staged.length === 0) return { imported: false, reason: "no-fork-data", copied: [], skipped };

  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  for (const { name, bytes } of staged) {
    const target = path.join(dataDirectory, name);
    const temporary = `${target}.import-${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, target);
    copied.push(name);
  }
  fs.writeFileSync(
    path.join(dataDirectory, FORK_IMPORT_MARKER),
    `${JSON.stringify({ from: FORK_PREVIOUS_PLUGIN_ID, at: now().toISOString(), copied, skipped }, null, 2)}\n`,
  );
  return { imported: true, reason: "imported", copied, skipped };
}
