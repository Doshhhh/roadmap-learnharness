// Sets the release version in manifest.json and package.json together. Does not commit or tag.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const files = ["manifest.json", "package.json"].map((name) => fileURLToPath(new URL(`../${name}`, import.meta.url)));
const [, , argument] = process.argv;
const current = JSON.parse(fs.readFileSync(files[0], "utf8")).version;
const [major, minor, patch] = current.split(".").map(Number);

const next = {
  major: `${major + 1}.0.0`,
  minor: `${major}.${minor + 1}.0`,
  patch: `${major}.${minor}.${patch + 1}`,
}[argument] ?? argument;

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(next ?? "")) {
  console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
  process.exit(1);
}
if (next === current) {
  console.error(`Version is already ${current}`);
  process.exit(1);
}

for (const file of files) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = next;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`Version ${current} -> ${next} in manifest.json and package.json`);
console.log(`Next: git commit -am "Release ${next}" && git tag v${next}`);
