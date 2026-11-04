// Search the open web but keep some sites out of the results.
//
//   npm install keenable
//   node exclude.mjs
//
// Keyless works; set KEENABLE_API_KEY to lift the hourly rate limit.

import { Keenable } from "keenable";

// Entry forms: a domain (also drops its subdomains), a domain with a path
// prefix (only that section of the site), or a suffix such as ".info".
const BLOCKED = ["pinterest.com", "medium.com/tag", ".info"];

const keenable = new Keenable();

const results = await keenable.search(
  "how to repot a monstera without damaging the roots",
  { excludeDomains: BLOCKED },
);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);

// excludeDomains carves pieces out of includeDomains; the same entry in both is a 400.
const unWithoutBlogs = await keenable.search("UN climate finance commitments", {
  includeDomains: ["un.org"],
  excludeDomains: ["blogs.un.org"],
});
console.log(`\nun.org without blogs.un.org: ${unWithoutBlogs.length} results`);
