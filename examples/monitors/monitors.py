"""Watch the web for a topic, read what the monitor found, and verify webhooks.

Run: pip install keenable && KEENABLE_API_KEY=keen_... python monitors.py
"""

from __future__ import annotations

from keenable import Keenable, WebhookVerificationError, verify_webhook

keenable = Keenable()

monitor = keenable.monitors.create(
    name="Open-weights LLMs",
    search={"query": "new open-weights LLM releases", "max_results": 20},
    schedule={"type": "interval", "value": "6h"},
    metadata={"team": "research"},
)
print(f"created {monitor.id}, next run {monitor.next_run_at}")

run = keenable.monitors.trigger(monitor.id)
print(f"run {run.id} is {run.status}")

for page in keenable.monitors.pages(monitor.id, min_importance=4):
    print(f"[{page.importance}] {page.title}\n    {page.url}\n    {page.summary}")


def handle_webhook(raw_body: bytes, headers: dict[str, str], secret: str) -> int:
    """What a webhook endpoint does with a delivery: verify, then act."""
    try:
        event = verify_webhook(raw_body, headers, secret)
    except WebhookVerificationError:
        return 400
    if event.type == "monitor.hit" and event.data.result:
        print("new page:", event.data.result.url)
    return 200


keenable.monitors.delete(monitor.id)
