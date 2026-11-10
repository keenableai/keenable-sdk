"""Smoke test of the Python SDK as published: one keyless search against prod.

Run in a clean environment after `pip install keenable==<version>`:
    python smoke.py <version>
"""

import sys
from urllib.parse import urlsplit

import keenable
from keenable import Keenable

expected = sys.argv[1]
if keenable.__version__ != expected:
    sys.exit(f"installed keenable {keenable.__version__}, expected {expected}")

client = Keenable(api_key="")
results = client.search("albert einstein wikipedia", exclude_domains=["wikipedia.org"])
hosts = [urlsplit(r.url).hostname or "" for r in results]
if not hosts:
    sys.exit("no results")
leaked = [h for h in hosts if h == "wikipedia.org" or h.endswith(".wikipedia.org")]
if leaked:
    sys.exit(f"exclude_domains leaked: {leaked}")
print(f"keenable {expected}: {len(hosts)} results, none from wikipedia.org")
