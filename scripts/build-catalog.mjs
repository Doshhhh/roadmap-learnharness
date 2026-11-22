// Regenerates src/catalog-snapshot.json from nilbuild/developer-roadmap via the gh CLI.
//
// Only file and directory NAMES are read. Roadmap slugs come from directory names under
// roadmaps/, topic slugs from the part of each topic file name before "@". Titles are the slug
// turned into words, so no upstream text (bodies, headings, links, descriptions) is copied.
// This script writes nothing except src/catalog-snapshot.json.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const OWNER = "nilbuild";
const REPO = "developer-roadmap";
const SOURCE_REPO = `${OWNER}/${REPO}`;
const SNAPSHOT_VERSION = 1;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOPIC_FILE = /^([^@/]+)@[^@/]+\.md$/;
const CONTENTS_PAGE_LIMIT = 1000; // the contents API returns at most 1000 entries per listing
const output = fileURLToPath(new URL("../src/catalog-snapshot.json", import.meta.url));

async function gh(args) {
  const { stdout } = await run("gh", ["api", ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Lists entry names of one directory at a pinned commit. Throws instead of truncating.
async function listNames(path, commit, jq) {
  const names = (await gh([`repos/${SOURCE_REPO}/contents/${path}?ref=${commit}`, "--jq", jq]))
    .split("\n")
    .filter((name) => name.length > 0);
  if (names.length >= CONTENTS_PAGE_LIMIT) throw new Error(`${path} may be truncated; refusing a partial snapshot.`);
  return names;
}

// "data-types" -> "Data types"
function titleFromSlug(slug) {
  const words = slug.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const sha = (await gh([`repos/${SOURCE_REPO}/commits/master`, "--jq", ".sha"])).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected commit id from GitHub: ${sha}`);

const roadmapSlugs = (await listNames("roadmaps", sha, '.[] | select(.type == "dir") | .name'))
  .filter((name) => SLUG.test(name))
  .sort();

const roadmaps = [];
let skippedTopicNames = 0;
for (const roadmapSlug of roadmapSlugs) {
  const names = await listNames(`roadmaps/${roadmapSlug}/content`, sha, ".[].name");
  const topicSlugs = new Set();
  for (const name of names) {
    const match = TOPIC_FILE.exec(name);
    if (!match || !SLUG.test(match[1])) {
      skippedTopicNames += 1;
      continue;
    }
    topicSlugs.add(match[1]);
  }
  const topics = [...topicSlugs].sort().map((slug) => ({
    slug,
    title: titleFromSlug(slug),
    roadmap: roadmapSlug,
    prerequisites: [],
    prerequisiteSource: "none",
  }));
  if (topics.length === 0) continue;
  roadmaps.push({
    slug: roadmapSlug,
    title: titleFromSlug(roadmapSlug),
    url: `https://roadmap.sh/${roadmapSlug}`,
    topics,
  });
}

const snapshot = {
  snapshotVersion: SNAPSHOT_VERSION,
  sourceRepo: SOURCE_REPO,
  sourceCommit: sha,
  roadmaps,
};

fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);

const topicCount = roadmaps.reduce((sum, roadmap) => sum + roadmap.topics.length, 0);
console.log(`Wrote ${output}`);
console.log(`commit ${sha}`);
console.log(`roadmaps ${roadmaps.length}, topics ${topicCount}, skipped non-topic names ${skippedTopicNames}`);
