"""Search only primary UN sources, then check every result against the list.

Run: pip install keenable && python un_allowlist.py
"""

from urllib.parse import urlsplit

from keenable import Keenable, KeenableAPIError

ALLOWED = ["press.un.org", "undocs.org", "documents.un.org"]

QUESTION = "Security Council resolution on the situation in Sudan"


def allowed(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    return any(host == d or host.endswith("." + d) for d in ALLOWED)


keenable = Keenable()

try:
    results = keenable.search(QUESTION, include_domains=ALLOWED, max_results=20)
except KeenableAPIError as err:
    raise SystemExit(f"rejected: {err}") from err

if warning := results.raw.get("warning"):
    print(f"warning: {warning}\n")

for result in results:
    print(f"{result.url}\n  {result.title}")

outside = [r.url for r in results if not allowed(r.url)]
print(f"\n{len(results)} results, {len(outside)} outside the allow-list")
if outside:
    raise SystemExit(f"unexpected hosts: {outside}")
