// Watch a pricing page for changes, read its history, and handle monitor.page.changed.
// Run (Node 22.18+): npm install keenable && KEENABLE_API_KEY=keen_... node pricing_page.ts

import { Keenable, verifyWebhook, WebhookVerificationError } from "keenable";

const keenable = new Keenable();

const monitor = await keenable.monitors.create({
  name: "Example pricing",
  type: "page",
  page: {
    url: "https://example.com/pricing",
    watchFor: "plan prices and new plans",
    sensitivity: "meaningful",
  },
  schedule: { type: "interval", value: "6h" },
});
console.log(`watching ${monitor.page?.url}, next check ${monitor.nextRunAt}`);

// The first run records the page as it is (the baseline); later runs compare.
const run = await keenable.monitors.trigger(monitor.id);
console.log(`run ${run.id} is ${run.status}`);

const runs = await keenable.monitors.runs(monitor.id, { limit: 10 });
for (const past of runs.data) {
  if (past.changes?.notified) {
    console.log(past.changes.summary);
    for (const item of past.changes.items) console.log(`  - ${item}`);
  }
}

const versions = await keenable.monitors.versions(monitor.id, { limit: 10 });
for (const version of versions.data) {
  console.log(`v${version.version} ${version.fetchedAt} (${version.source}):`, version.diff?.added ?? []);
}

// What a webhook endpoint does with a delivery: verify, then act.
export async function handleWebhook(request: Request, secret: string): Promise<Response> {
  try {
    const event = await verifyWebhook(await request.text(), request.headers, secret);
    if (event.type === "monitor.page.changed") console.log("the page changed:", event.data.run?.changes?.summary);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 400 });
    throw error;
  }
}

await keenable.monitors.delete(monitor.id);
