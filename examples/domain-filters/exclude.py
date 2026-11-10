"""Search the open web but keep some sites out of the results.

Run: pip install keenable && python exclude.py
"""

from keenable import Keenable

BLOCKED = ["pinterest.com", "quora.com", "reddit.com"]

keenable = Keenable()

results = keenable.search(
    "how to repot a monstera without damaging the roots",
    exclude_domains=BLOCKED,
)

for result in results:
    print(f"{result.url}\n  {result.title}")
