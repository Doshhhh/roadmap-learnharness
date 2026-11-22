import fs from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8")).version;
const manifest = read("manifest.json");
const pkg = read("package.json");

if (manifest !== pkg) {
  console.error(`Version mismatch: manifest.json ${manifest}, package.json ${pkg}. Run node scripts/release.mjs <version>.`);
  process.exit(1);
}
console.log(`Versions agree: ${manifest}`);
