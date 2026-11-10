// Smoke test of the TypeScript SDK as published: one keyless search against prod.
// Run (Node 22.18+) in a clean directory after `npm install keenable@<version>`:
//   node smoke.ts <version>
import { readFileSync } from "node:fs";
import { Keenable } from "keenable";

const expected = process.argv[2];
// `exports` hides package.json, so read the installed copy from disk.
const installed = JSON.parse(readFileSync("node_modules/keenable/package.json", "utf8")).version;
if (installed !== expected) throw new Error(`installed keenable ${installed}, expected ${expected}`);

const results = await new Keenable({ apiKey: "" }).search("albert einstein wikipedia", {
  excludeDomains: ["wikipedia.org"],
});
const hosts = [...results].map((r) => new URL(r.url).hostname);
if (hosts.length === 0) throw new Error("no results");
const leaked = hosts.filter((h) => h === "wikipedia.org" || h.endsWith(".wikipedia.org"));
if (leaked.length > 0) throw new Error(`exclude_domains leaked: ${leaked.join(", ")}`);
console.log(`keenable ${expected}: ${hosts.length} results, none from wikipedia.org`);
