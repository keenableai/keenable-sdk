// Watch the web for a topic, read what the monitor found, and verify webhooks.
// Run (Node 22.18+): npm install keenable && KEENABLE_API_KEY=keen_... node monitors.ts

import { Keenable, verifyWebhook, WebhookVerificationError } from "keenable";

const keenable = new Keenable();

const monitor = await keenable.monitors.create({
  name: "Open-weights LLMs",
  search: { query: "new open-weights LLM releases", maxResults: 20 },
  schedule: { type: "interval", value: "6h" },
  metadata: { team: "research" },
});
console.log(`created ${monitor.id}, next run ${monitor.nextRunAt}`);

const run = await keenable.monitors.trigger(monitor.id);
console.log(`run ${run.id} is ${run.status}`);

const results = await keenable.monitors.results(monitor.id, { minImportance: 4 });
for (const result of results.data) {
  console.log(`[${result.importance}] ${result.title}\n    ${result.url}\n    ${result.summary}`);
}

// What a webhook endpoint does with a delivery: verify, then act.
export async function handleWebhook(request: Request, secret: string): Promise<Response> {
  try {
    const event = await verifyWebhook(await request.text(), request.headers, secret);
    if (event.type === "monitor.result.found") console.log("new result:", event.data.result?.url);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 400 });
    throw error;
  }
}

await keenable.monitors.delete(monitor.id);
