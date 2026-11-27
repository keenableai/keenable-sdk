"""Live smoke test: one keyless search and one keyless fetch against production.

Run with the keenable package installed: python smoke.py
Exits non-zero, with the reason, if either call fails or comes back empty.
"""

import sys

from keenable import Keenable, __version__

QUERY = "how do solar panels work"
URL = "https://example.com"
# The page's title and text both say what example.com is for; checking for the
# word keeps the test from breaking when the wording changes.
EXPECT = "example"


def fail(message: str) -> None:
    print(f"smoke FAILED (python, keenable {__version__}): {message}", file=sys.stderr)
    sys.exit(1)


keenable = Keenable()

results = keenable.search(QUERY)
if not results.results:
    fail(f"search {QUERY!r} returned no results (request {results.request_id})")
first = results.results[0]
if not first.url.startswith("http"):
    fail(f"first search result has no URL: {first!r}")
print(f"search: {len(results.results)} results, first {first.url}")

response = keenable.fetch([URL])
if len(response.results) != 1:
    fail(f"fetch returned {len(response.results)} pages for 1 URL")
page = response.results[0]
if page.error:
    fail(f"fetch {URL}: {page.error.status} {page.error.code} {page.error.error}")
if not page.content.strip() or EXPECT not in (page.title + page.content).lower():
    fail(f"fetch {URL}: unexpected page {page.title!r}: {page.content[:200]!r}")
print(f"fetch: {page.url} {len(page.content)} chars")
print(f"smoke ok (python, keenable {__version__})")
