// Live smoke test: one keyless search and one keyless fetch against production.
//
// Run (Node 22.18+) next to an installed keenable package: node smoke.ts
// Exits non-zero, with the reason, if either call fails or comes back empty.

import { Keenable } from "keenable";

const QUERY = "how do solar panels work";
const URL = "https://example.com";
// The page's title and text both say what example.com is for; checking for the
// word keeps the test from breaking when the wording changes.
const EXPECT = "example";

function fail(message: string): never {
  console.error(`smoke FAILED (typescript): ${message}`);
  process.exit(1);
}

const keenable = new Keenable();

const results = await keenable.search(QUERY);
const first = results.results[0];
if (!first) fail(`search ${JSON.stringify(QUERY)} returned no results (request ${results.requestId})`);
if (!first.url.startsWith("http")) fail(`first search result has no URL: ${JSON.stringify(first)}`);
console.log(`search: ${results.results.length} results, first ${first.url}`);

const response = await keenable.fetch([URL]);
if (response.results.length !== 1) fail(`fetch returned ${response.results.length} pages for 1 URL`);
const page = response.results[0];
if (!page) fail("fetch returned no page");
if (page.error) fail(`fetch ${URL}: ${page.error.status} ${page.error.code} ${page.error.error}`);
if (!page.content.trim() || !(page.title + page.content).toLowerCase().includes(EXPECT)) {
  fail(`fetch ${URL}: unexpected page ${JSON.stringify(page.title)}: ${JSON.stringify(page.content.slice(0, 200))}`);
}
console.log(`fetch: ${page.url} ${page.content.length} chars`);
console.log("smoke ok (typescript)");
