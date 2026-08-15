/**
 * Let a Cerebras model decide when to search the web, via tool calling.
 *
 *   npm install keenable @cerebras/cerebras_cloud_sdk
 *   export CEREBRAS_API_KEY="..."   # KEENABLE_API_KEY is optional
 *   node tool_calling.mjs
 */

import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { Keenable, TOOLS, runToolCall } from 'keenable';

const MODEL = 'gpt-oss-120b';
const QUESTION = 'What did Cerebras announce most recently, and when?';

const keenable = new Keenable();
const cerebras = new Cerebras({ apiKey: process.env['CEREBRAS_API_KEY'] });

const messages = [
  {
    role: 'system',
    content:
      'You are a research assistant. Use the web tools whenever the answer ' +
      'depends on recent information, and cite the URLs you used.',
  },
  { role: 'user', content: QUESTION },
];

// TOOLS holds OpenAI-compatible definitions for keenable_search and
// keenable_fetch, so they go straight into the request.
while (true) {
  const completion = await cerebras.chat.completions.create({
    model: MODEL,
    messages,
    tools: TOOLS,
  });
  const message = completion.choices[0].message;

  if (!message.tool_calls?.length) {
    console.log(message.content);
    break;
  }

  messages.push(message);
  for (const call of message.tool_calls) {
    // runToolCall executes whichever tool the model picked and returns text
    // ready to hand back.
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: await runToolCall(keenable, call.function.name, call.function.arguments),
    });
  }
}
