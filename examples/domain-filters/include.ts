// Search only some sites.
// Run (Node 22.18+): npm install keenable && node include.ts

import { Keenable } from "keenable";

const ALLOWED: string[] = ["arxiv.org", "openreview.net", ".edu"];

const keenable = new Keenable();

const results = await keenable.search(
  "post-training quantization of large language models",
  { includeDomains: ALLOWED },
);

for (const result of results) console.log(`${result.url}\n  ${result.title}`);
