/** Read-only access to the developer-roadmap topic files (issue #19).
 *
 * Two operations and nothing else: list the topics of one roadmap, and read one
 * topic's title, description and tagged resources. Requests go to the GitHub
 * contents API at one pinned commit, and only under `roadmaps/`.
 *
 * Privacy: a request URL is built from constants, the repository path, a commit
 * SHA and slugs that passed the strict pattern below. Nothing else reaches the
 * network: no learner text, statements, goals or headers derived from them.
 * The fetch function is injected, so tests never touch the network.
 */

export const UPSTREAM_REPOSITORY = "nilbuild/developer-roadmap";
export const UPSTREAM_API_BASE = "https://api.github.com";
/** The pinned upstream commit: nilbuild/developer-roadmap master when this release was cut.
 * Every request reads this commit. It is set by hand and never fetched from master at runtime. */
export const UPSTREAM_PINNED_COMMIT = "6675ce60868ce44aeecc439ad39b3df22453a8ce";
/** The source named on every topic read; resources are attributed to it. */
export const UPSTREAM_SOURCE = "roadmap.sh";
/** Longest topic file accepted, in UTF-16 code units. Real topic files are far smaller. */
export const MAX_TOPIC_CHARS = 200_000;

/** A slug is lowercase letters and digits, joined by a single hyphen, a double hyphen (`ci--cd`) or a
 * single dot (`node.js`). Every separator sits between two alphanumerics, so `.`, `..`, `../x`, `a/b`,
 * `a..b`, `--x`, `x--` and anything with a backslash, slash, `?`, `#` or `%` are all refused. */
const SLUG_PATTERN = /^[a-z0-9]+(?:(?:--|[-.])[a-z0-9]+)*$/;
const MAX_SLUG_CHARS = 80;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/** Topic file names are `<slug>@<id>.md`. */
const TOPIC_FILE_PATTERN = /^([a-z0-9]+(?:(?:--|[-.])[a-z0-9]+)*)@[A-Za-z0-9_-]+\.md$/;
/** A tagged resource: `[@book@Title](https://...)`. The link text and URL are kept as written. */
const RESOURCE_PATTERN = /\[(@[^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export interface UpstreamResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The only network seam. Tests pass a fake; production passes a fetch wrapper. */
export type UpstreamFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<UpstreamResponse>;

/** Longest wait for one GitHub response, headers and body together. A slower request is reported as unreachable. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** Wrap a real fetch so every request is bounded by `timeoutMs`. The caller's init is passed through unchanged. */
export function withUpstreamTimeout(
  send: (url: string, init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }) => Promise<UpstreamResponse>,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): UpstreamFetch {
  return (url, init) => send(url, { headers: init.headers, signal: AbortSignal.timeout(timeoutMs) });
}

export interface UpstreamOptions {
  readonly fetch: UpstreamFetch;
  /** Topic listings already read, keyed by roadmap and commit. Optional: when given, a listing is fetched once
   * and reused, because a pinned commit never changes. A failed read is not kept, so the next call retries. */
  readonly listings?: Map<string, Promise<UpstreamTopicRef[]>>;
}

export type UpstreamErrorKind = "invalid" | "not_found" | "unreachable";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  constructor(kind: UpstreamErrorKind, message: string) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
  }
}

export interface UpstreamTopicRef {
  readonly slug: string;
  /** The file name in roadmaps/<roadmap>/content, as published. */
  readonly file: string;
}

export interface UpstreamResource {
  /** Link text as written, tag included, e.g. "@book@Some Title". */
  readonly label: string;
  /** The tag between the @ signs, e.g. "book" or "official"; null when there is none. */
  readonly tag: string | null;
  /** The URL exactly as written in the topic file. */
  readonly url: string;
}

export interface UpstreamTopic {
  readonly roadmap: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly resources: readonly UpstreamResource[];
  readonly source: typeof UPSTREAM_SOURCE;
  readonly repository: typeof UPSTREAM_REPOSITORY;
  readonly commit: string;
}

/** Slug check. Rejects anything that could name a path other than one plain folder or file stem. */
export function assertSlug(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > MAX_SLUG_CHARS || !SLUG_PATTERN.test(value)) {
    throw new UpstreamError("invalid", `${what} must be a lowercase slug (letters, digits, single dots, and hyphens that are not at the start or end).`);
  }
  return value;
}

function assertCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new UpstreamError("invalid", "The upstream commit must be a full 40-character SHA.");
  }
  return value;
}

function contentsUrl(roadmapSlug: string, commit: string, file?: string): string {
  const folder = `roadmaps/${roadmapSlug}/content`;
  const path = file === undefined ? folder : `${folder}/${file}`;
  return `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPOSITORY}/contents/${path}?ref=${commit}`;
}

const HEADERS_JSON = {
  Accept: "application/vnd.github+json",
  "User-Agent": "learnharness-roadmap-plugin",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;
const HEADERS_RAW = { ...HEADERS_JSON, Accept: "application/vnd.github.raw" } as const;

async function request(fetchFn: UpstreamFetch, url: string, headers: Readonly<Record<string, string>>, what: string): Promise<string> {
  let response: UpstreamResponse;
  try {
    response = await fetchFn(url, { headers });
  } catch {
    throw new UpstreamError("unreachable", `GitHub could not be reached while reading ${what}.`);
  }
  if (response.status === 404) throw new UpstreamError("not_found", `${what} was not found at the pinned commit.`);
  if (!response.ok) throw new UpstreamError("unreachable", `GitHub returned status ${response.status} for ${what}.`);
  try {
    return await response.text();
  } catch {
    throw new UpstreamError("unreachable", `GitHub returned an unreadable response for ${what}.`);
  }
}

/** Topic files of one roadmap at one commit. With `options.listings`, the listing is read once per roadmap and commit. */
export async function listRoadmapTopics(
  roadmapSlug: string,
  commit: string,
  options: UpstreamOptions,
): Promise<UpstreamTopicRef[]> {
  const roadmap = assertSlug(roadmapSlug, "roadmapSlug");
  const sha = assertCommit(commit);
  const cache = options.listings;
  const key = `${roadmap}@${sha}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const pending = fetchTopicListing(roadmap, sha, options);
  if (cache) {
    cache.set(key, pending);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
  }
  return pending;
}

async function fetchTopicListing(roadmap: string, sha: string, options: UpstreamOptions): Promise<UpstreamTopicRef[]> {
  const body = await request(options.fetch, contentsUrl(roadmap, sha), HEADERS_JSON, `roadmap "${roadmap}"`);
  let entries: unknown;
  try {
    entries = JSON.parse(body);
  } catch {
    throw new UpstreamError("unreachable", `GitHub returned an unreadable listing for roadmap "${roadmap}".`);
  }
  if (!Array.isArray(entries)) throw new UpstreamError("not_found", `Roadmap "${roadmap}" has no content folder.`);
  const topics: UpstreamTopicRef[] = [];
  for (const entry of entries) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name !== "string") continue;
    const match = TOPIC_FILE_PATTERN.exec(name);
    if (match) topics.push({ slug: match[1] as string, file: name });
  }
  return topics;
}

/** Title, description and tagged resources of one topic, as the file writes them. */
export function parseTopicMarkdown(markdown: string): { title: string; description: string; resources: UpstreamResource[] } {
  const lines = markdown.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = titleIndex === -1 ? "" : (lines[titleIndex] as string).replace(/^#\s+/, "").trim();
  const paragraph: string[] = [];
  for (const line of lines.slice(titleIndex + 1)) {
    const text = line.trim();
    if (text === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^(#|[-*+]\s|\[|\d+\.\s)/.test(text)) break;
    paragraph.push(text);
  }
  const resources: UpstreamResource[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(RESOURCE_PATTERN)) {
    const label = match[1] as string;
    const url = match[2] as string;
    const key = `${label}\u0000${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = /^@([^@\s]+)@/.exec(label);
    resources.push({ label, tag: tag ? (tag[1] as string) : null, url });
  }
  return { title, description: paragraph.join(" "), resources };
}

/** One topic: its title, description and resources, read from its file at the pinned commit. */
export async function readTopic(
  roadmapSlug: string,
  topicSlug: string,
  commit: string,
  options: UpstreamOptions,
): Promise<UpstreamTopic> {
  const roadmap = assertSlug(roadmapSlug, "roadmapSlug");
  const topic = assertSlug(topicSlug, "topicSlug");
  const sha = assertCommit(commit);
  const ref = (await listRoadmapTopics(roadmap, sha, options)).find((candidate) => candidate.slug === topic);
  if (!ref) throw new UpstreamError("not_found", `Topic "${topic}" was not found in roadmap "${roadmap}".`);
  const markdown = await request(
    options.fetch,
    contentsUrl(roadmap, sha, ref.file),
    HEADERS_RAW,
    `topic "${topic}" of roadmap "${roadmap}"`,
  );
  if (markdown.length > MAX_TOPIC_CHARS) throw new UpstreamError("invalid", `Topic "${topic}" is larger than the reader accepts.`);
  return {
    roadmap,
    slug: topic,
    ...parseTopicMarkdown(markdown),
    source: UPSTREAM_SOURCE,
    repository: UPSTREAM_REPOSITORY,
    commit: sha,
  };
}
