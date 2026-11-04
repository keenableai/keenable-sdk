// Search only primary UN sources, then check every result against the list.
// Run: npm install keenable && node un_allowlist.mjs

import { Keenable, KeenableAPIError } from "keenable";

const ALLOWED = ["press.un.org", "undocs.org", "documents.un.org"];

const QUESTION = "Security Council resolution on the situation in Sudan";

function allowed(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return ALLOWED.some((d) => host === d || host.endsWith(`.${d}`));
}

const keenable = new Keenable();

let results;
try {
  results = await keenable.search(QUESTION, { includeDomains: ALLOWED, maxResults: 20 });
} catch (err) {
  if (err instanceof KeenableAPIError) {
    console.error(`rejected: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (results.raw.warning) console.log(`warning: ${results.raw.warning}\n`);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);

const outside = results.results.filter((r) => !allowed(r.url)).map((r) => r.url);
console.log(`\n${results.length} results, ${outside.length} outside the allow-list`);
if (outside.length > 0) {
  console.error("unexpected hosts:", outside);
  process.exit(1);
}
