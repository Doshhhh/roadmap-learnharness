/** Learning Path — versioned, atomic persistence under `ctx.dataDirectory`.
 *
 * Owns exactly these files:
 *   roadmaps-index.json      versioned roadmap order, ids and the migration marker
 *   roadmaps/<stem>.json     one versioned file per roadmap; the stem is a hash of the id
 *   learning-paths.json      legacy single file; migrated once, then kept as
 *                            learning-paths.json.migrated
 *   settings.json            versioned plugin settings
 *   architect.json           chosen Architect model (needed to re-register)
 *   sources/<sourceId>.md    converted learner uploads (UUID names only)
 *   sources/index.json       versioned upload metadata, for hash deduplication
 * Host-reserved `agents/`, `tasks/` and `usage.jsonl` are never read or written.
 *
 * Writes go to a same-directory temporary file, are fsynced and renamed over the
 * target, so a crash never leaves a half-written store. Reads validate the schema
 * version and every record: corrupt JSON, invalid records and newer schema versions
 * throw instead of being overwritten, because the learner's data cannot be rebuilt.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DomainValidationError,
  THINKING_LEVELS,
  isSourceId,
  parseLearningPath,
  parsePluginSettings,
  parseUploadedSourceReference,
  validateLearningPath,
} from "./domain.ts";
import type {
  LearningPath,
  PluginSettings,
  ThinkingLevelName,
  UploadedSourceReference,
} from "./domain.ts";

export const STORE_SCHEMA_VERSION = 1;
export const LEARNING_PATHS_FILE = "learning-paths.json";
export const ROADMAPS_DIRECTORY = "roadmaps";
/** The roadmap index sits in the data folder root, so no roadmap file name can ever reach it. */
export const ROADMAP_INDEX_FILE = "roadmaps-index.json";
/** Version of the one-time move from `learning-paths.json` to `roadmaps/`. */
export const ROADMAP_MIGRATION_VERSION = 1;
export const MIGRATED_LEGACY_SUFFIX = ".migrated";
export const SETTINGS_FILE = "settings.json";
export const ARCHITECT_FILE = "architect.json";
export const SOURCES_DIRECTORY = "sources";
export const SOURCE_INDEX_FILE = "index.json";
/** Frontend conversion is bounded; this is the backend's own last line of defence. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Thinking levels are part of the validated domain contract. */
export { THINKING_LEVELS };
export type { ThinkingLevelName } from "./domain.ts";

/** The Architect definition needs an explicit model, which survives restart in
 * `architect.json`; plugin settings may override it through the Settings page. */
export interface ArchitectModelConfig {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevel?: ThinkingLevelName;
}

export interface SavedSource {
  readonly reference: UploadedSourceReference;
  /** True when identical Markdown was already stored; no new file was written. */
  readonly deduplicated: boolean;
}
/** Host services own these; the plugin must never touch them. */
export const HOST_RESERVED_ENTRIES = ["agents", "tasks", "usage.jsonl"] as const;

/** `stale` means the file changed on disk: the store reloaded it and the save was not written. */
export type StoreErrorCode = "corrupt" | "newer-schema" | "unsupported-schema" | "unsafe" | "io" | "stale";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
    this.code = code;
  }
}

export function defaultSettings(): PluginSettings {
  return { artifactDefaults: {} };
}

/** UUID-only source ids keep converted uploads inside `sources/`. */
export function assertSourceId(value: unknown): string {
  if (!isSourceId(value)) {
    throw new StoreError("io", "Invalid source ID: expected a UUID.");
  }
  return value.toLowerCase();
}

interface SettingsFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly settings: PluginSettings;
}

interface SourceIndexFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly sources: readonly UploadedSourceReference[];
}

interface ArchitectFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly model: ArchitectModelConfig;
}

function asRecord(value: unknown, filename: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: expected a JSON object. No data was changed.`);
  }
  return value as Record<string, unknown>;
}

/** Text of a managed file; `undefined` when it does not exist. Symlinks and non-files are refused. */
function readTextFile(filename: string): string | undefined {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    throw new StoreError("unsafe", `Refusing to follow symlinked Learning Path file: ${filename}. No data was changed.`);
  }
  if (!stat.isFile()) {
    throw new StoreError("corrupt", `Learning Path path is not a regular file: ${filename}. No data was changed.`);
  }
  return fs.readFileSync(filename, "utf8");
}

function parseJsonText(text: string, filename: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: invalid JSON. No data was changed.`);
  }
}

function readJsonFile(filename: string): unknown | undefined {
  const text = readTextFile(filename);
  return text === undefined ? undefined : parseJsonText(text, filename);
}

/** SHA-256 of the exact bytes of a managed file; the store compares it with what is on disk before writing. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readSchemaVersion(record: Record<string, unknown>, filename: string): number {
  const version = record.schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: missing schema version. No data was changed.`);
  }
  if ((version as number) > STORE_SCHEMA_VERSION) {
    throw new StoreError(
      "newer-schema",
      `Roadmap data at ${filename} uses newer schema version ${version}; this plugin supports ${STORE_SCHEMA_VERSION}. No data was changed.`,
    );
  }
  if (version !== STORE_SCHEMA_VERSION) {
    throw new StoreError(
      "unsupported-schema",
      `Roadmap data at ${filename} uses unsupported schema version ${version}. No data was changed.`,
    );
  }
  return version;
}

function readRevision(record: Record<string, unknown>, filename: string): number {
  const revision = record.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: invalid revision. No data was changed.`);
  }
  return revision as number;
}

function loadPathsFile(filename: string): { paths: LearningPath[]; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) return { paths: [], revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  if (!Array.isArray(record.paths)) {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: paths must be an array. No data was changed.`);
  }
  const seen = new Set<string>();
  const paths = record.paths.map((value, index) => {
    const result = validateLearningPath(value);
    if (!result.ok) {
      const issue = result.issues[0];
      throw new StoreError(
        "corrupt",
        `Roadmap data at ${filename} is corrupt: paths[${index}] ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
      );
    }
    if (seen.has(result.value.id)) {
      throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: duplicate path id "${result.value.id}". No data was changed.`);
    }
    seen.add(result.value.id);
    return result.value;
  });
  return { paths, revision };
}

interface RoadmapFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly roadmap: LearningPath;
}

interface RoadmapIndexFile {
  readonly schemaVersion: number;
  readonly revision: number;
  /** Roadmap ids in display order. A refused roadmap keeps its place here. */
  readonly roadmaps: readonly string[];
  readonly migration: RoadmapMigrationMarker;
}

interface RoadmapMigrationMarker {
  readonly version: number;
  /** The legacy file the roadmaps came from, or null when the store started empty. */
  readonly from: string | null;
}

/** A roadmap file the store refused on open. It is never overwritten or deleted. */
export interface RoadmapRefusal {
  readonly id: string;
  readonly filename: string;
  readonly code: StoreErrorCode;
  readonly message: string;
}

const ROADMAP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** True when this data folder already holds Roadmap data in any layout, so one-time importers must not run.
 * Covers the legacy file, the split layout and the migrated copy kept after the split. */
export function hasRoadmapData(dataDirectory: string): boolean {
  const present = (name: string): boolean => fs.lstatSync(path.join(dataDirectory, name), { throwIfNoEntry: false }) !== undefined;
  return (
    present(LEARNING_PATHS_FILE) ||
    present(ROADMAP_INDEX_FILE) ||
    present(ROADMAPS_DIRECTORY) ||
    present(`${LEARNING_PATHS_FILE}${MIGRATED_LEGACY_SUFFIX}`)
  );
}

/** File stem of a roadmap: lowercase hex of the SHA-256 of its id, always 64 characters of [0-9a-f].
 * Lowercase-only hex means no two stems differ only by case, so ids such as "Index" and "index"
 * never collide on a case-insensitive file system. A fixed length keeps every name far below the
 * 255-byte limit (a 128-character id written as plain hex would not fit). An id can never produce
 * the index's name, and the id itself is stored inside the roadmap file. */
export function roadmapFileStem(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

export function roadmapFileName(id: string): string {
  return `${roadmapFileStem(id)}.json`;
}

/** Refuse `id` when its file name would collide with another listed id's, ignoring case.
 * `nameOf` defaults to the real encoding; a test can pass a lossy one to exercise the rule. */
export function assertRoadmapNameFree(
  existingIds: Iterable<string>,
  id: string,
  nameOf: (candidate: string) => string = roadmapFileName,
): void {
  const wanted = nameOf(id).toLowerCase();
  for (const other of existingIds) {
    if (other !== id && nameOf(other).toLowerCase() === wanted) {
      throw new StoreError(
        "io",
        `Roadmap "${id}" would share a file name with roadmap "${other}" on a case-insensitive file system. It was not saved.`,
      );
    }
  }
}

function roadmapFilename(directory: string, id: string): string {
  return path.join(directory, ROADMAPS_DIRECTORY, roadmapFileName(id));
}

function pathExists(filename: string): boolean {
  return fs.lstatSync(filename, { throwIfNoEntry: false }) !== undefined;
}

function roadmapEnvelope(roadmap: LearningPath, revision: number): RoadmapFile {
  return { schemaVersion: STORE_SCHEMA_VERSION, revision, roadmap };
}

function indexEnvelope(ids: readonly string[], revision: number, migration: RoadmapMigrationMarker): RoadmapIndexFile {
  return { schemaVersion: STORE_SCHEMA_VERSION, revision, roadmaps: ids, migration };
}

/** Parse the roadmap index text; throws `StoreError` to refuse it. */
function parseRoadmapIndexText(text: string, filename: string): { ids: string[]; revision: number; migration: RoadmapMigrationMarker | null } {
  const record = asRecord(parseJsonText(text, filename), filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  if (!Array.isArray(record.roadmaps)) {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: roadmaps must be an array. No data was changed.`);
  }
  const seen = new Set<string>();
  const ids = record.roadmaps.map((value, index) => {
    if (typeof value !== "string" || !ROADMAP_ID_PATTERN.test(value)) {
      throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: roadmaps[${index}] is not a roadmap id. No data was changed.`);
    }
    if (seen.has(value)) {
      throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: duplicate roadmap id "${value}". No data was changed.`);
    }
    seen.add(value);
    return value;
  });
  let migration: RoadmapMigrationMarker | null = null;
  if (record.migration !== undefined) {
    const marker = record.migration as Record<string, unknown> | null;
    if (
      marker === null ||
      typeof marker !== "object" ||
      !Number.isSafeInteger(marker.version) ||
      (marker.from !== null && typeof marker.from !== "string")
    ) {
      throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: invalid migration marker. No data was changed.`);
    }
    migration = { version: marker.version as number, from: marker.from as string | null };
  }
  return { ids, revision, migration };
}

/** Parse the roadmap index; `null` when it does not exist yet. */
function loadRoadmapIndex(filename: string): { ids: string[]; revision: number; migration: RoadmapMigrationMarker | null } | null {
  const text = readTextFile(filename);
  return text === undefined ? null : parseRoadmapIndexText(text, filename);
}

/** Parse one roadmap file's text and check it holds the roadmap its name says. Throws `StoreError` to refuse it. */
function parseRoadmapText(text: string, filename: string, id: string): { roadmap: LearningPath; revision: number } {
  const record = asRecord(parseJsonText(text, filename), filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  const result = validateLearningPath(record.roadmap);
  if (!result.ok) {
    const issue = result.issues[0];
    throw new StoreError(
      "corrupt",
      `Roadmap data at ${filename} is corrupt: roadmap ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
    );
  }
  if (result.value.id !== id) {
    throw new StoreError(
      "corrupt",
      `Roadmap data at ${filename} is corrupt: it holds roadmap "${result.value.id}", not "${id}". No data was changed.`,
    );
  }
  return { roadmap: result.value, revision };
}

/** Parse one roadmap file; a missing file is an error here (the caller decides what absence means). */
function loadRoadmapFile(filename: string, id: string): { roadmap: LearningPath; revision: number } {
  const text = readTextFile(filename);
  if (text === undefined) {
    throw new StoreError("corrupt", `Roadmap file ${filename} is missing. No data was changed.`);
  }
  return parseRoadmapText(text, filename, id);
}

/** One-time move of the legacy `learning-paths.json` into `roadmaps/`.
 * The legacy file is renamed only after every new file was written, read back and matched.
 * Any failure removes the new files this attempt wrote and leaves the legacy file as it was. */
function migrateLegacyPaths(directory: string): void {
  const legacy = path.join(directory, LEARNING_PATHS_FILE);
  const roadmapsDirectory = path.join(directory, ROADMAPS_DIRECTORY);
  const indexFilename = path.join(directory, ROADMAP_INDEX_FILE);
  // Corrupt, newer or symlinked legacy data is refused here, before anything is written.
  const { paths } = loadPathsFile(legacy);
  const ids = paths.map((roadmap) => roadmap.id);
  ids.forEach((id, position) => assertRoadmapNameFree(ids.slice(0, position), id));
  const created: string[] = [];
  try {
    fs.mkdirSync(roadmapsDirectory, { recursive: true, mode: 0o700 });
    for (const roadmap of paths) {
      const filename = roadmapFilename(directory, roadmap.id);
      const content = serialize(roadmapEnvelope(roadmap, 1));
      if (pathExists(filename)) {
        // Only an identical leftover from an interrupted run is accepted; anything else is never overwritten.
        const existing = fs.lstatSync(filename);
        if (!existing.isFile() || existing.isSymbolicLink() || fs.readFileSync(filename, "utf8") !== content) {
          throw new StoreError(
            "io",
            `Migration stopped: ${filename} already exists and differs from learning-paths.json. Nothing was overwritten; learning-paths.json is untouched.`,
          );
        }
        continue;
      }
      atomicWrite(filename, content);
      created.push(filename);
    }
    atomicWrite(
      indexFilename,
      serialize(indexEnvelope(ids, 1, { version: ROADMAP_MIGRATION_VERSION, from: LEARNING_PATHS_FILE })),
    );
    created.push(indexFilename);
    // Read every new file back before the legacy file may move.
    for (const roadmap of paths) {
      const back = loadRoadmapFile(roadmapFilename(directory, roadmap.id), roadmap.id);
      if (serialize(back.roadmap) !== serialize(roadmap)) {
        throw new StoreError("corrupt", `Migrated roadmap "${roadmap.id}" does not read back equal. learning-paths.json is untouched.`);
      }
    }
    const index = loadRoadmapIndex(indexFilename);
    if (
      index === null ||
      index.ids.join("\n") !== ids.join("\n") ||
      index.migration?.version !== ROADMAP_MIGRATION_VERSION
    ) {
      throw new StoreError("corrupt", "The migrated roadmap index does not read back as written. learning-paths.json is untouched.");
    }
  } catch (problem) {
    // Roll back only the new files this attempt wrote; the legacy file was never touched.
    for (const filename of created.reverse()) {
      try {
        fs.unlinkSync(filename);
      } catch {
        // Leave whatever could not be removed; the legacy file is still the source of truth.
      }
    }
    if (problem instanceof StoreError) throw problem;
    throw new StoreError("io", `Migration of learning-paths.json failed. learning-paths.json is untouched. ${problem instanceof Error ? problem.message : String(problem)}`, { cause: problem });
  }
  // Keep the old data under a name that is never reused, so an earlier copy is never overwritten.
  let migrated = `${legacy}${MIGRATED_LEGACY_SUFFIX}`;
  if (pathExists(migrated)) migrated = `${migrated}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(legacy, migrated);
  } catch (problem) {
    // The roadmaps are safe; the migration never runs again because the index now exists.
    console.warn("[roadmap] migrated roadmaps, but could not rename learning-paths.json:", problem instanceof Error ? problem.message : problem);
  }
}

function loadSettingsFile(filename: string): { settings: PluginSettings; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) return { settings: defaultSettings(), revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  try {
    return { settings: parsePluginSettings(record.settings), revision };
  } catch {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: invalid settings. No data was changed.`);
  }
}

/** Validate the persisted Architect model; same guards as any other store file. */
function parseArchitectModel(value: unknown): ArchitectModelConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Architect model must be an object.");
  }
  const record = value as Record<string, unknown>;
  const readText = (candidate: unknown, field: string): string => {
    if (typeof candidate !== "string") throw new Error(`Architect model ${field} must be a string.`);
    if (!candidate.trim() || candidate !== candidate.trim()) {
      throw new Error(`Architect model ${field} must be non-blank without surrounding whitespace.`);
    }
    if (candidate.length > 200) throw new Error(`Architect model ${field} is too long.`);
    return candidate;
  };
  const model: ArchitectModelConfig = {
    provider: readText(record.provider, "provider"),
    id: readText(record.id, "id"),
    ...(record.thinkingLevel === undefined
      ? {}
      : {
          thinkingLevel: (() => {
            const level = record.thinkingLevel;
            if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
              throw new Error(`Architect model thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}.`);
            }
            return level as ThinkingLevelName;
          })(),
        }),
  };
  return model;
}

function loadArchitectFile(filename: string): { model: ArchitectModelConfig | null; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) return { model: null, revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  try {
    return { model: parseArchitectModel(record.model), revision };
  } catch {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: invalid Architect model. No data was changed.`);
  }
}

function loadSourceIndex(directory: string): { sources: UploadedSourceReference[]; revision: number } {
  const filename = path.join(directory, SOURCE_INDEX_FILE);
  const raw = readJsonFile(filename);
  if (raw === undefined) return { sources: [], revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  if (!Array.isArray(record.sources)) {
    throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: sources must be an array. No data was changed.`);
  }
  const seen = new Set<string>();
  const sources = record.sources.map((entry, index) => {
    let parsed: UploadedSourceReference;
    try {
      parsed = parseUploadedSourceReference(entry);
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      const issue = error.issues[0];
      throw new StoreError(
        "corrupt",
        `Roadmap data at ${filename} is corrupt: sources[${index}] ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
      );
    }
    if (seen.has(parsed.sourceId)) {
      throw new StoreError("corrupt", `Roadmap data at ${filename} is corrupt: duplicate source id "${parsed.sourceId}". No data was changed.`);
    }
    seen.add(parsed.sourceId);
    return parsed;
  });
  return { sources, revision };
}

/** Best-effort directory fsync so the rename itself is durable after a crash. */
function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms/filesystems reject directory fsync; the rename is still atomic.
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore a failing close of the best-effort descriptor.
      }
    }
  }
}

/** Write a complete file atomically; on failure the previous bytes and temp cleanup win.
 * Identical bytes are not written again, so an unchanged save leaves the file's mtime alone. */
function atomicWrite(filename: string, content: string): void {
  const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new StoreError("unsafe", `Refusing to overwrite symlinked Learning Path file: ${filename}. No data was changed.`);
  }
  if (existing?.isFile() && fs.readFileSync(filename, "utf8") === content) return;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore; the original error is more useful.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Object keys sorted at every depth; array order is data and stays as it is. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Pretty-printed JSON with a stable key order, so the same data always gives the same bytes. */
function serialize(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** True when the file already holds this data (revision aside), so a save would change nothing. */
function sameData(filename: string, revision: number, current: unknown, next: unknown): boolean {
  return revision > 0 && fs.existsSync(filename) && serialize(current) === serialize(next);
}

export interface LearningPathStore {
  /** Absolute data directory this store owns. */
  readonly directory: string;
  /** Roadmaps that loaded, in roadmap-index order. Refused roadmaps are listed by `refusals()`. */
  paths(): readonly LearningPath[];
  path(id: string): LearningPath | null;
  /** Roadmap files refused on open. Each is left on disk untouched; saving or deleting it throws. */
  refusals(): readonly RoadmapRefusal[];
  /** Validate and atomically create/update one path, keyed by path id. */
  savePath(value: unknown): LearningPath;
  deletePath(id: string): boolean;
  settings(): PluginSettings;
  saveSettings(value: unknown): PluginSettings;
  /** The explicit model the Path Architect definition is registered with. */
  architectModel(): ArchitectModelConfig | null;
  saveArchitectModel(value: unknown): ArchitectModelConfig;
  /** Stored uploads with metadata; unindexed `.md` files are listed too. */
  sources(): readonly UploadedSourceReference[];
  /** Store converted Markdown, deduplicating identical content by SHA-256 + size. */
  saveSource(value: unknown): SavedSource;
  writeSource(sourceId: string, markdown: string): void;
  readSource(sourceId: string): string | null;
  removeSource(sourceId: string): void;
  listSourceIds(): readonly string[];
}

/**
 * Open the store for one `ctx.dataDirectory`.
 * Throws `StoreError` for corrupt/unsafe/newer data before anything is written.
 */
export function openLearningPathStore(dataDirectory: string): LearningPathStore {
  const directory = path.resolve(dataDirectory);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new StoreError("io", `Learning Path data directory is not a directory: ${directory}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const settingsFilename = path.join(directory, SETTINGS_FILE);
  const architectFilename = path.join(directory, ARCHITECT_FILE);
  const sourcesDirectory = path.join(directory, SOURCES_DIRECTORY);
  const roadmapsDirectory = path.join(directory, ROADMAPS_DIRECTORY);
  const roadmapIndexFilename = path.join(directory, ROADMAP_INDEX_FILE);

  // The one-time move runs only while the index is missing, so it never runs twice.
  if (!pathExists(roadmapIndexFilename) && pathExists(path.join(directory, LEARNING_PATHS_FILE))) {
    migrateLegacyPaths(directory);
  }
  let order: string[] = [];
  let indexState: { revision: number; migration: RoadmapMigrationMarker | null } = { revision: 0, migration: null };
  /** Digest of the index bytes the store last read or wrote; null when the index was absent. */
  let indexDigest: string | null = null;
  const roadmapState = new Map<string, { roadmap: LearningPath; revision: number }>();
  const refusals = new Map<string, RoadmapRefusal>();
  /** Digest of each roadmap file's bytes as the store last read or wrote it (null when absent or unreadable). */
  const fileDigests = new Map<string, string | null>();

  type RoadmapOnDisk =
    | { readonly kind: "absent" }
    | { readonly kind: "valid"; readonly digest: string; readonly roadmap: LearningPath; readonly revision: number }
    | { readonly kind: "invalid"; readonly digest: string | null; readonly problem: StoreError };

  /** Read one roadmap file as it is on disk now. Never writes. */
  const inspectRoadmap = (id: string): RoadmapOnDisk => {
    const filename = roadmapFilename(directory, id);
    let text: string | undefined;
    try {
      text = readTextFile(filename);
    } catch (problem) {
      if (!(problem instanceof StoreError)) throw problem;
      return { kind: "invalid", digest: null, problem };
    }
    if (text === undefined) return { kind: "absent" };
    const digest = digestOf(text);
    try {
      return { kind: "valid", digest, ...parseRoadmapText(text, filename, id) };
    } catch (problem) {
      if (!(problem instanceof StoreError)) throw problem;
      return { kind: "invalid", digest, problem };
    }
  };

  /** The refusal for a file that cannot be read. Git-caused damage points the learner at the Git view. */
  const refusalFor = (id: string, filename: string, problem: StoreError, prefix = ""): RoadmapRefusal => ({
    id,
    filename,
    code: problem.code,
    message:
      problem.code === "newer-schema"
        ? `${prefix}${problem.message}`
        : `${prefix}${problem.message} Resolve it in the Git view; nothing is written to this roadmap until the file reads cleanly.`,
  });

  /** Read the index and every roadmap file from disk, replacing what the store holds in memory.
   * Each roadmap file is loaded on its own: one bad file is refused without blocking the others. */
  const loadRoadmapState = (): void => {
    const indexText = readTextFile(roadmapIndexFilename);
    const index = indexText === undefined ? null : parseRoadmapIndexText(indexText, roadmapIndexFilename);
    order = index?.ids ?? [];
    indexState = { revision: index?.revision ?? 0, migration: index?.migration ?? null };
    indexDigest = indexText === undefined ? null : digestOf(indexText);
    roadmapState.clear();
    refusals.clear();
    fileDigests.clear();
    for (const id of order) {
      const disk = inspectRoadmap(id);
      const filename = roadmapFilename(directory, id);
      if (disk.kind === "absent") {
        fileDigests.set(id, null); // Listed but missing: nothing to refuse and nothing to lose.
      } else if (disk.kind === "valid") {
        roadmapState.set(id, { roadmap: disk.roadmap, revision: disk.revision });
        fileDigests.set(id, disk.digest);
      } else {
        refusals.set(id, refusalFor(id, filename, disk.problem));
        fileDigests.set(id, disk.digest);
      }
    }
  };
  loadRoadmapState();

  /** Before any write, the index on disk must still be the one the store last read or wrote. */
  const ensureIndexFresh = (): void => {
    const text = readTextFile(roadmapIndexFilename);
    const digest = text === undefined ? null : digestOf(text);
    if (digest === indexDigest) return;
    if (text !== undefined) {
      try {
        parseRoadmapIndexText(text, roadmapIndexFilename);
      } catch (problem) {
        if (!(problem instanceof StoreError)) throw problem;
        throw new StoreError(
          problem.code,
          `Roadmap index ${roadmapIndexFilename} changed on disk and no longer reads cleanly. ${problem.code === "newer-schema" ? problem.message : `${problem.message} Resolve it in the Git view.`} Nothing was written.`,
          { cause: problem },
        );
      }
    }
    loadRoadmapState();
    throw new StoreError(
      "stale",
      `Roadmap index ${roadmapIndexFilename} changed on disk after the store last read it. The roadmap list was reloaded and your change was NOT saved; review it and save again.`,
    );
  };

  let settingsState = loadSettingsFile(settingsFilename);
  let architectState = loadArchitectFile(architectFilename);
  let sourceState = loadSourceIndex(sourcesDirectory);

  const sourceFilename = (sourceId: string): string =>
    path.join(sourcesDirectory, `${assertSourceId(sourceId)}.md`);

  const isStoredSource = (sourceId: string): boolean => {
    const fileStat = fs.lstatSync(sourceFilename(sourceId), { throwIfNoEntry: false });
    return Boolean(fileStat?.isFile() && !fileStat.isSymbolicLink());
  };

  const writeSourceIndex = (sources: UploadedSourceReference[]): void => {
    const indexFilename = path.join(sourcesDirectory, SOURCE_INDEX_FILE);
    if (sameData(indexFilename, sourceState.revision, sourceState.sources, sources)) return;
    fs.mkdirSync(sourcesDirectory, { recursive: true, mode: 0o700 });
    atomicWrite(
      indexFilename,
      serialize({
        schemaVersion: STORE_SCHEMA_VERSION,
        revision: sourceState.revision + 1,
        sources,
      } satisfies SourceIndexFile),
    );
    sourceState = { sources, revision: sourceState.revision + 1 };
  };

  /** Indexed uploads that still have their file, plus Markdown written directly. */
  const listSources = (): UploadedSourceReference[] => {
    const indexed = sourceState.sources.filter((source) => isStoredSource(source.sourceId));
    const known = new Set(indexed.map((source) => source.sourceId));
    const orphans = listSourceIdsImpl()
      .filter((sourceId) => !known.has(sourceId))
      .map((sourceId) => {
        const filename = sourceFilename(sourceId);
        const fileStat = fs.statSync(filename);
        return {
          sourceId,
          name: `${sourceId}.md`,
          uploadedAt: fileStat.mtime.toISOString(),
          byteSize: fileStat.size,
        } satisfies UploadedSourceReference;
      });
    return [...indexed, ...orphans];
  };

  const listSourceIdsImpl = (): string[] => {
    const entries = fs.existsSync(sourcesDirectory)
      ? fs.readdirSync(sourcesDirectory, { withFileTypes: true })
      : [];
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length))
      .filter((candidate) => isSourceId(candidate))
      .map((candidate) => candidate.toLowerCase())
      .sort();
  };

  const writeSourceFile = (sourceId: string, markdown: string): void => {
    const id = assertSourceId(sourceId);
    if (typeof markdown !== "string") {
      throw new StoreError("io", "Converted source Markdown must be a string.");
    }
    fs.mkdirSync(sourcesDirectory, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(sourcesDirectory, `${id}.md`), markdown);
  };

  const loadedPaths = (): LearningPath[] =>
    order.flatMap((id) => {
      const entry = roadmapState.get(id);
      return entry ? [entry.roadmap] : [];
    });

  const assertNotRefused = (id: string): void => {
    const refusal = refusals.get(id);
    if (refusal) {
      throw new StoreError(refusal.code, `Roadmap "${id}" was refused and was not changed. ${refusal.message}`);
    }
  };

  /** Before a write touches roadmap `id`, its file on disk must be the one the store last read or wrote.
   * A changed file is reloaded and the save refused; an invalid one is refused; a newer one is refused. */
  const ensureRoadmapFresh = (id: string): void => {
    const filename = roadmapFilename(directory, id);
    const disk = inspectRoadmap(id);
    const known = roadmapState.has(id);
    if (disk.kind === "invalid") {
      if (refusals.has(id) && fileDigests.get(id) === disk.digest) assertNotRefused(id);
      roadmapState.delete(id);
      const refusal = refusalFor(id, filename, disk.problem, `Roadmap file ${filename} changed on disk. `);
      refusals.set(id, refusal);
      fileDigests.set(id, disk.digest);
      throw new StoreError(refusal.code, `Roadmap "${id}" was not saved. ${refusal.message}`, { cause: disk.problem });
    }
    if (disk.kind === "absent") {
      if (known) {
        // The removal may be deliberate (a Git pull, or the learner), so the roadmap is never silently recreated.
        roadmapState.delete(id);
        fileDigests.set(id, null);
        throw new StoreError(
          "stale",
          `Roadmap file ${filename} was removed on disk after the store last read it. The roadmap was dropped from memory and your change was NOT saved. If it was removed by mistake, restore it in the Git view.`,
        );
      }
      if (refusals.has(id)) {
        // The refused file is gone from disk, so there is nothing left to protect.
        refusals.delete(id);
        fileDigests.set(id, null);
      }
      return;
    }
    if (known && fileDigests.get(id) === disk.digest) return;
    // Changed (or unknown to memory): reload it and refuse this save, so the external change is never overwritten.
    roadmapState.set(id, { roadmap: disk.roadmap, revision: disk.revision });
    refusals.delete(id);
    fileDigests.set(id, disk.digest);
    throw new StoreError(
      "stale",
      `Roadmap file ${filename} changed on disk after the store last read it. The roadmap was reloaded from disk and your change was NOT saved; review the reloaded roadmap and save again.`,
    );
  };

  /** Rewrite the index only when the order or the membership changed. */
  const writeRoadmapIndex = (ids: string[]): void => {
    fs.mkdirSync(roadmapsDirectory, { recursive: true, mode: 0o700 });
    const migration = indexState.migration ?? { version: ROADMAP_MIGRATION_VERSION, from: null };
    const content = serialize(indexEnvelope(ids, indexState.revision + 1, migration));
    atomicWrite(roadmapIndexFilename, content);
    indexState = { revision: indexState.revision + 1, migration };
    indexDigest = digestOf(content);
    order = ids;
  };

  const writeRoadmapFile = (roadmap: LearningPath, revision: number): void => {
    fs.mkdirSync(roadmapsDirectory, { recursive: true, mode: 0o700 });
    const content = serialize(roadmapEnvelope(roadmap, revision));
    atomicWrite(roadmapFilename(directory, roadmap.id), content);
    fileDigests.set(roadmap.id, digestOf(content));
  };

  return {
    directory,

    paths: () => loadedPaths(),

    path(id) {
      return roadmapState.get(id)?.roadmap ?? null;
    },

    refusals: () => [...refusals.values()],

    savePath(value) {
      const parsed = parseLearningPath(value);
      ensureIndexFresh();
      if (order.includes(parsed.id) || roadmapState.has(parsed.id) || refusals.has(parsed.id)) {
        ensureRoadmapFresh(parsed.id);
      }
      const current = roadmapState.get(parsed.id);
      if (current) {
        // Unchanged data writes nothing; a change rewrites only this roadmap's file.
        if (serialize(current.roadmap) === serialize(parsed)) return parsed;
        writeRoadmapFile(parsed, current.revision + 1);
        roadmapState.set(parsed.id, { roadmap: parsed, revision: current.revision + 1 });
        return parsed;
      }
      // A new id must not share a file name with a listed one; refuse rather than overwrite.
      assertRoadmapNameFree(order, parsed.id);
      // An unlisted file of this name is a leftover; it is never overwritten.
      const filename = roadmapFilename(directory, parsed.id);
      if (pathExists(filename)) {
        throw new StoreError(
          "io",
          `Roadmap file ${filename} exists but is not in the roadmap index, so it was not overwritten.`,
        );
      }
      // The index goes first: a crash in between leaves a listed roadmap with no file, which reads as absent.
      if (!order.includes(parsed.id)) writeRoadmapIndex([...order, parsed.id]);
      writeRoadmapFile(parsed, 1);
      roadmapState.set(parsed.id, { roadmap: parsed, revision: 1 });
      return parsed;
    },

    deletePath(id) {
      ensureIndexFresh();
      if (order.includes(id) || roadmapState.has(id) || refusals.has(id)) ensureRoadmapFresh(id);
      const current = roadmapState.get(id);
      if (!current && !order.includes(id)) return false;
      // The index goes first, so a crash never leaves an index entry pointing at a deleted file.
      if (order.includes(id)) writeRoadmapIndex(order.filter((candidate) => candidate !== id));
      roadmapState.delete(id);
      fileDigests.delete(id);
      try {
        fs.unlinkSync(roadmapFilename(directory, id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return current !== undefined;
    },

    settings: () => settingsState.settings,

    saveSettings(value) {
      const parsed = parsePluginSettings(value);
      if (sameData(settingsFilename, settingsState.revision, settingsState.settings, parsed)) return parsed;
      atomicWrite(
        settingsFilename,
        serialize({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision: settingsState.revision + 1,
          settings: parsed,
        } satisfies SettingsFile),
      );
      settingsState = { settings: parsed, revision: settingsState.revision + 1 };
      return parsed;
    },

    architectModel: () => architectState.model,

    saveArchitectModel(value) {
      const parsed = parseArchitectModel(value);
      if (sameData(architectFilename, architectState.revision, architectState.model, parsed)) return parsed;
      atomicWrite(
        architectFilename,
        serialize({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision: architectState.revision + 1,
          model: parsed,
        } satisfies ArchitectFile),
      );
      architectState = { model: parsed, revision: architectState.revision + 1 };
      return parsed;
    },

    sources: () => listSources(),

    saveSource(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("io", "A source upload needs an object with name and markdown.");
      }
      const record = value as Record<string, unknown>;
      const name = record.name;
      const markdown = record.markdown;
      if (typeof name !== "string") {
        throw new StoreError("io", "A source upload needs a non-blank name.");
      }
      if (typeof markdown !== "string" || markdown.trim().length === 0) {
        throw new StoreError("io", "Converted source Markdown must be a non-empty string.");
      }
      const byteSize = Buffer.byteLength(markdown, "utf8");
      if (byteSize > MAX_SOURCE_BYTES) {
        throw new StoreError("io", `Converted source is ${byteSize} bytes; the limit is ${MAX_SOURCE_BYTES}.`);
      }
      const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
      // Validate the request before dedupe can short-circuit it.
      const reference = parseUploadedSourceReference({
        sourceId: randomUUID(),
        name,
        uploadedAt: new Date().toISOString(),
        byteSize,
        sha256,
      });

      const duplicate = sourceState.sources.find(
        (source) =>
          source.sha256 === sha256 &&
          source.byteSize === byteSize &&
          isStoredSource(source.sourceId),
      );
      if (duplicate) return { reference: duplicate, deduplicated: true };

      // Drop stale index rows whose file vanished; they must not shadow a new upload.
      const live = sourceState.sources.filter((source) => isStoredSource(source.sourceId));
      writeSourceFile(reference.sourceId, markdown);
      writeSourceIndex([...live, reference]);
      return { reference, deduplicated: false };
    },

    writeSource(sourceId, markdown) {
      writeSourceFile(sourceId, markdown);
    },

    readSource(sourceId) {
      const id = assertSourceId(sourceId);
      const filename = path.join(sourcesDirectory, `${id}.md`);
      const fileStat = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (!fileStat) return null;
      if (fileStat.isSymbolicLink()) {
        throw new StoreError("unsafe", `Refusing to follow symlinked source file: ${filename}.`);
      }
      if (!fileStat.isFile()) {
        throw new StoreError("corrupt", `Source path is not a regular file: ${filename}.`);
      }
      return fs.readFileSync(filename, "utf8");
    },

    removeSource(sourceId) {
      const id = assertSourceId(sourceId);
      try {
        fs.unlinkSync(sourceFilename(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const remaining = sourceState.sources.filter((source) => source.sourceId !== id);
      if (remaining.length !== sourceState.sources.length) writeSourceIndex(remaining);
    },

    listSourceIds: () => listSourceIdsImpl(),
  };
}
