// Search the open web but keep some sites out of the results.
// Run: npm install keenable && node exclude.mjs

import { Keenable } from "keenable";

const BLOCKED = ["pinterest.com", "medium.com/tag", ".info"];

const keenable = new Keenable();

const results = await keenable.search(
  "how to repot a monstera without damaging the roots",
  { excludeDomains: BLOCKED },
);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);

const unWithoutBlogs = await keenable.search("UN climate finance commitments", {
  includeDomains: ["un.org"],
  excludeDomains: ["blogs.un.org"],
});
console.log(`\nun.org without blogs.un.org: ${unWithoutBlogs.length} results`);
