// Keyless Keenable search from TypeScript: no account, no API key.
// On StackBlitz this runs by itself; edit the query and it runs again.
// Locally: npm install && npm start

import { Keenable, KeenableAPIError } from "keenable";

const keenable = new Keenable(); // keyless; set KEENABLE_API_KEY to lift the hourly cap

const query = "how wafer scale chips avoid the memory bottleneck";

try {
  const results = await keenable.search(query, { maxResults: 5 });

  console.log(`${results.results.length} results for "${query}"\n`);

  // A numbered, citable block, ready to drop into an LLM prompt.
  console.log(results.toContext({ maxChars: 4000 }));
} catch (err) {
  if (err instanceof KeenableAPIError) {
    // Branch on `code`; `fix` says what to do next.
    console.error(`${err.code}: ${err.fix ?? err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
