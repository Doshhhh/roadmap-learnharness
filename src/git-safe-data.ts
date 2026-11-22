/** Keeps the learning data folder safe to version with a Git plugin (learnharness-git).
 *
 * The Git plugin commits the whole data folder, honouring nested `.gitignore` files.
 * This module makes sure `<data>/.gitignore` keeps the secrets, the metadata-only logs
 * and any temporary files out of that history. It only ever adds lines: the learner's
 * own lines are kept, and a file that already has every entry is not rewritten.
 *
 * Folders the plugin writes under the data directory:
 *   secrets/          search-key.json (plain-text API key)          -> ignored
 *   logs/             architect.jsonl (timing log)                  -> ignored
 *   *.tmp             leftovers of an interrupted atomic write      -> ignored
 *   roadmaps-index.json and roadmaps/ (one file per roadmap), settings.json, architect.json,
 *   sources/, research/, research-chats.json, declined-proposals.json -> versioned
 * The plugin keeps no on-disk cache, so there is no cache folder to ignore.
 */
import fs from "node:fs";
import path from "node:path";

export const GITIGNORE_FILE = ".gitignore";
/** Entries the plugin needs in `<data>/.gitignore`, in the order they are appended. */
export const GITIGNORE_ENTRIES = ["secrets/", "logs/", "*.tmp"] as const;

/** Return `existing` with any missing entries appended; `changed` is false when nothing was added. */
export function mergeGitignore(existing: string, entries: readonly string[] = GITIGNORE_ENTRIES): { text: string; changed: boolean } {
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return { text: existing, changed: false };
  const head = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  return { text: `${head}${missing.join("\n")}\n`, changed: true };
}

/**
 * Create or extend `<dataDirectory>/.gitignore`. Never throws: a failed write is
 * reported with `console.warn` and the plugin carries on without it.
 */
export function ensureDataGitignore(dataDirectory: string): void {
  try {
    const file = path.join(dataDirectory, GITIGNORE_FILE);
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const { text, changed } = mergeGitignore(existing);
    if (!changed) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, text, "utf8");
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } catch (problem) {
    console.warn("[roadmap] could not update the data folder .gitignore:", problem instanceof Error ? problem.message : problem);
  }
}
