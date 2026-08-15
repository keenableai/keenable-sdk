/**
 * Ground a Cerebras model in live web results from Keenable.
 *
 *   npm install keenable @cerebras/cerebras_cloud_sdk
 *   export CEREBRAS_API_KEY="..."
 *   export KEENABLE_API_KEY="..."
 *   node grounded_answer.mjs
 */

import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { Keenable } from 'keenable';

const question = 'Which inference providers are fastest on gpt-oss-120b right now?';

const keenable = new Keenable({ apiKey: process.env['KEENABLE_API_KEY'] });
const cerebras = new Cerebras({ apiKey: process.env['CEREBRAS_API_KEY'] });

// One call gets ranked pages with their text already extracted, and
// toContext() renders them as a numbered, citable block.
const results = await keenable.search(question, { publishedAfter: '2026-01-01' });

const completion = await cerebras.chat.completions.create({
  model: 'gpt-oss-120b',
  messages: [
    {
      role: 'system',
      content:
        'Answer using only the sources provided. Cite them by their number, ' +
        'like [1]. If the sources do not answer the question, say so.',
    },
    { role: 'user', content: `${results.toContext()}\n\nQuestion: ${question}` },
  ],
});

console.log(completion.choices[0].message.content);

// cited() reports the results that made it into the context, in the order the
// model cites them, so this list cannot drift from the [n] markers it used.
console.log('\nSources:');
results.cited().forEach((result, index) => {
  console.log(`[${index + 1}] ${result.title} - ${result.url}`);
});
