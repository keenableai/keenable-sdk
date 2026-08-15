"""Ground a Cerebras model in live web results from Keenable.

    pip install keenable cerebras_cloud_sdk
    export CEREBRAS_API_KEY="..."
    export KEENABLE_API_KEY="..."
    python grounded_answer.py
"""

import os

from cerebras.cloud.sdk import Cerebras

from keenable import Keenable

QUESTION = "Which inference providers are fastest on gpt-oss-120b right now?"

keenable = Keenable(api_key=os.environ.get("KEENABLE_API_KEY"))
cerebras = Cerebras(api_key=os.environ.get("CEREBRAS_API_KEY"))

# One call gets ranked pages with their text already extracted, and
# to_context() renders them as a numbered, citable block.
results = keenable.search(QUESTION, published_after="2026-01-01")
context = results.to_context()

completion = cerebras.chat.completions.create(
    model="gpt-oss-120b",
    messages=[
        {
            "role": "system",
            "content": (
                "Answer using only the sources provided. Cite them by their "
                "number, like [1]. If the sources do not answer the question, "
                "say so."
            ),
        },
        {"role": "user", "content": f"{context}\n\nQuestion: {QUESTION}"},
    ],
)

print(completion.choices[0].message.content)

# cited() reports the results that made it into the context, in the order the
# model cites them, so this list cannot drift from the [n] markers it used.
print("\nSources:")
for index, result in enumerate(results.cited(), start=1):
    print(f"[{index}] {result.title} - {result.url}")
