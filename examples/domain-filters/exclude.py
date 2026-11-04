"""Search the open web but keep some sites out of the results.

    pip install keenable
    python exclude.py

Keyless works; set KEENABLE_API_KEY to lift the hourly rate limit.
"""

from keenable import Keenable

# Entry forms: a domain (also drops its subdomains), a domain with a path
# prefix (only that section of the site), or a suffix such as ".info".
BLOCKED = ["pinterest.com", "medium.com/tag", ".info"]

keenable = Keenable()

results = keenable.search(
    "how to repot a monstera without damaging the roots",
    exclude_domains=BLOCKED,
)

for result in results:
    print(f"{result.url}\n  {result.title}")

# exclude_domains carves pieces out of include_domains; the same entry in both is a 400.
un_without_blogs = keenable.search(
    "UN climate finance commitments",
    include_domains=["un.org"],
    exclude_domains=["blogs.un.org"],
)
print(f"\nun.org without blogs.un.org: {len(un_without_blogs)} results")
