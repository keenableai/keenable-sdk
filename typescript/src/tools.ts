/**
 * Ready-made tool definitions for OpenAI-compatible tool calling.
 *
 * Every major inference API (Cerebras, OpenAI, and anything speaking the same
 * schema) takes tools in this shape, so these can be passed straight into a
 * `chat.completions.create({ tools })` call.
 */

import type { Keenable } from "./client.js";
import { KeenableInvalidRequestError } from "./errors.js";
import { TOOL_FILTERS, toolProperties } from "./filters.js";
import { nonEmpty } from "./internal.js";
import type { SearchOptions } from "./types.js";

/** An OpenAI-compatible function tool definition. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "keenable_search",
    description:
      "Search the web for current information. Returns ranked pages with their " +
      "title, URL and extracted page text. Use this whenever the answer depends " +
      "on recent events or facts you are unsure about.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look for, described in natural language rather than keywords.",
        },
        // Only the filters marked tool-exposed; see filters.ts.
        ...toolProperties(),
      },
      required: ["query"],
    },
  },
};

export const FETCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "keenable_fetch",
    description:
      "Fetch one web page and return its main content as markdown. Use after " +
      "keenable_search when a search snippet is not enough.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL of the page to read." },
      },
      required: ["url"],
    },
  },
};

export const TOOLS: ToolDefinition[] = [SEARCH_TOOL, FETCH_TOOL];

function parseArguments(args: string | Record<string, unknown>): Record<string, unknown> {
  // An array is `typeof "object"` but carries no named arguments, so let it
  // fall through to the same rejection a JSON array gets below.
  if (typeof args === "object" && args !== null && !Array.isArray(args)) return args;
  if (typeof args !== "string") {
    throw new KeenableInvalidRequestError(
      `tool call arguments must be a JSON string or an object, got ${JSON.stringify(args)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || "{}");
  } catch {
    throw new KeenableInvalidRequestError(
      `tool call arguments are not valid JSON: ${JSON.stringify(args)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KeenableInvalidRequestError(
      `tool call arguments must be a JSON object, got ${JSON.stringify(parsed)}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function requireString(value: unknown, message: string): string {
  const text = nonEmpty(value);
  if (text === undefined) throw new KeenableInvalidRequestError(message);
  return text;
}

/** Keep only the filters the tool schema actually offers the model. */
function toolFilterOptions(args: Record<string, unknown>): SearchOptions {
  const options: Record<string, unknown> = {};
  for (const filter of TOOL_FILTERS) {
    const value = nonEmpty(args[filter.wire]);
    if (value !== undefined) options[filter.option] = value;
  }
  return options as SearchOptions;
}

/**
 * Execute one tool call and return the string to send back as the result.
 *
 * Pass the tool name and raw arguments straight from the model's response; the
 * return value is ready to attach to a `role: "tool"` message, rendered as the
 * same numbered, citable block for both tools.
 */
export async function runToolCall(
  client: Keenable,
  name: string,
  args: string | Record<string, unknown>,
): Promise<string> {
  const parsed = parseArguments(args);

  if (name === "keenable_search") {
    const query = requireString(parsed.query, "keenable_search needs a 'query'");
    const response = await client.search(query, toolFilterOptions(parsed));
    return response.toContext();
  }

  if (name === "keenable_fetch") {
    const url = requireString(parsed.url, "keenable_fetch needs a 'url'");
    const page = await client.fetch(url);
    return page.toContext();
  }

  throw new KeenableInvalidRequestError(`unknown Keenable tool: ${JSON.stringify(name)}`);
}
