// Search the open web but keep some sites out of the results.
// Run: npm install keenable && node exclude.mjs

import { Keenable } from "keenable";

const BLOCKED = ["pinterest.com", "quora.com", "reddit.com"];

const keenable = new Keenable();

const results = await keenable.search(
  "how to repot a monstera without damaging the roots",
  { excludeDomains: BLOCKED },
);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);
