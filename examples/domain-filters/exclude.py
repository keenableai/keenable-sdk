"""Search the open web but keep some sites out of the results.

Run: pip install keenable && python exclude.py
"""

from keenable import Keenable

BLOCKED = ["pinterest.com", "medium.com/tag", ".info"]

keenable = Keenable()

results = keenable.search(
    "how to repot a monstera without damaging the roots",
    exclude_domains=BLOCKED,
)

for result in results:
    print(f"{result.url}\n  {result.title}")

un_without_blogs = keenable.search(
    "UN climate finance commitments",
    include_domains=["un.org"],
    exclude_domains=["blogs.un.org"],
)
print(f"\nun.org without blogs.un.org: {len(un_without_blogs)} results")
