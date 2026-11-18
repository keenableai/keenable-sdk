"""Watch a pricing page for changes, read its history, and handle monitor.change.

Run: pip install keenable && KEENABLE_API_KEY=keen_... python pricing_page.py
"""

from __future__ import annotations

from keenable import Keenable, WebhookVerificationError, verify_webhook

keenable = Keenable()

monitor = keenable.monitors.create(
    name="Example pricing",
    type="page",
    page={
        "url": "https://example.com/pricing",
        "watch_for": "plan prices and new plans",
        "sensitivity": "meaningful",
    },
    schedule={"type": "interval", "value": "6h"},
)
assert monitor.page is not None
print(f"watching {monitor.page.url}, next check {monitor.next_run_at}")

# The first run records the page as it is (the baseline); later runs compare.
run = keenable.monitors.trigger(monitor.id)
print(f"run {run.id} is {run.status}")

for past in keenable.monitors.runs(monitor.id, limit=10):
    if past.changes and past.changes.notified:
        print(past.changes.summary)
        for item in past.changes.items:
            print("  -", item)

for version in keenable.monitors.versions(monitor.id, limit=10):
    added = version.diff.added if version.diff else []
    print(f"v{version.version} {version.fetched_at} ({version.source}): {added}")


def handle_webhook(raw_body: bytes, headers: dict[str, str], secret: str) -> int:
    """What a webhook endpoint does with a delivery: verify, then act."""
    try:
        event = verify_webhook(raw_body, headers, secret)
    except WebhookVerificationError:
        return 400
    if event.type == "monitor.change" and event.data.run and event.data.run.changes:
        print("the page changed:", event.data.run.changes.summary)
    return 200


keenable.monitors.delete(monitor.id)
