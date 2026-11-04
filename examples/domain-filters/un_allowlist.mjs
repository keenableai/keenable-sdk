// Search only primary UN sources, then check every result against the list.
//
//   npm install keenable
//   node un_allowlist.mjs
//
// Keyless works; set KEENABLE_API_KEY to lift the hourly rate limit.

import { Keenable, KeenableAPIError } from "keenable";

// A domain also matches its subdomains, so "un.org" would admit news.un.org
// too. These three are the UN's own document and press-release sites.
const ALLOWED = ["press.un.org", "undocs.org", "documents.un.org"];

const QUESTION = "Security Council resolution on the situation in Sudan";

/** True when the URL's host is an allowed domain or one of its subdomains. */
function allowed(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return ALLOWED.some((d) => host === d || host.endsWith(`.${d}`));
}

const keenable = new Keenable();

let results;
try {
  results = await keenable.search(QUESTION, { includeDomains: ALLOWED, maxResults: 20 });
} catch (err) {
  // A malformed entry is a 400 naming the field, the entry and the reason.
  if (err instanceof KeenableAPIError) {
    console.error(`rejected: ${err.message}`, err.data);
    process.exit(1);
  }
  throw err;
}

// A narrow allow-list can return fewer than maxResults. When the API had to
// remove results to honour the list, it says so in the response's warning.
if (results.raw.warning) console.log(`warning: ${results.raw.warning}\n`);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);

const outside = results.results.filter((r) => !allowed(r.url)).map((r) => r.url);
console.log(`\n${results.length} results, ${outside.length} outside the allow-list`);
if (outside.length > 0) {
  console.error("unexpected hosts:", outside);
  process.exit(1);
}
