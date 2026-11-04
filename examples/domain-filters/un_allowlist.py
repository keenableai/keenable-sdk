"""Search only primary UN sources, then check every result against the list.

    pip install keenable
    python un_allowlist.py

Keyless works; set KEENABLE_API_KEY to lift the hourly rate limit.
"""

from urllib.parse import urlsplit

from keenable import Keenable, KeenableAPIError

# A domain also matches its subdomains, so "un.org" would admit news.un.org
# too. These three are the UN's own document and press-release sites.
ALLOWED = ["press.un.org", "undocs.org", "documents.un.org"]

QUESTION = "Security Council resolution on the situation in Sudan"


def allowed(url: str) -> bool:
    """True when the URL's host is an allowed domain or one of its subdomains."""
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    return any(host == d or host.endswith("." + d) for d in ALLOWED)


keenable = Keenable()

try:
    results = keenable.search(QUESTION, include_domains=ALLOWED, max_results=20)
except KeenableAPIError as err:
    # A malformed entry is a 400 whose message names the field, entry and reason.
    raise SystemExit(f"rejected: {err}") from err

# A narrow allow-list can return fewer than max_results; the API then sets a warning.
if warning := results.raw.get("warning"):
    print(f"warning: {warning}\n")

for result in results:
    print(f"{result.url}\n  {result.title}")

outside = [r.url for r in results if not allowed(r.url)]
print(f"\n{len(results)} results, {len(outside)} outside the allow-list")
if outside:
    raise SystemExit(f"unexpected hosts: {outside}")
