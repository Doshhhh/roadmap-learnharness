import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(root, process.argv[2] ?? "learnharness-plugins/types");
const target = path.join(root, ".sdk");

const manifest = path.join(source, "package.json");
if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).name !== "learnharness-plugin-api") {
  console.error(`No learnharness-plugin-api SDK at ${source}.`);
  console.error("Download the authoring skill (Settings → Community plugins) and pass its types/ path: npm run sdk -- <path>");
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log(`Copied SDK from ${source} to ${target}`);
