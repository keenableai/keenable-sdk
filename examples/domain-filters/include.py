"""Search only some sites.

Run: pip install keenable && python include.py
"""

from keenable import Keenable

ALLOWED = ["arxiv.org", "openreview.net", ".edu"]

keenable = Keenable()

results = keenable.search(
    "post-training quantization of large language models",
    include_domains=ALLOWED,
)

for result in results:
    print(f"{result.url}\n  {result.title}")
