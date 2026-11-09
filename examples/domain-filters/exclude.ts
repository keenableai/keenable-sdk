// Search the open web but keep some sites out of the results.
// Run (Node 22.18+): npm install keenable && node exclude.ts

import { Keenable } from "keenable";

const BLOCKED: string[] = ["pinterest.com", "quora.com", "reddit.com"];

const keenable = new Keenable();

const results = await keenable.search(
  "how to repot a monstera without damaging the roots",
  { excludeDomains: BLOCKED },
);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);
