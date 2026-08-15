/**
 * Ready-made tool definitions for OpenAI-compatible tool calling.
 *
 * Every major inference API (Cerebras, OpenAI, and anything speaking the same
 * schema) takes tools in this shape, so these can be passed straight into a
 * `chat.completions.create({ tools })` call.
 */

import type { Keenable } from "./client.js";
import { KeenableInvalidRequestError } from "./errors.js";

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
        site: {
          type: "string",
          description: "Optional. Restrict results to one domain, e.g. 'arxiv.org'.",
        },
        published_after: {
          type: "string",
          description:
            "Optional. Only pages published on or after this date (YYYY-MM-DD).",
        },
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
  if (typeof args === "object" && args !== null) return args;
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new KeenableInvalidRequestError(message);
  }
  return value;
}

/**
 * Execute one tool call and return the string to send back as the result.
 *
 * Pass the tool name and raw arguments straight from the model's response; the
 * return value is ready to attach to a `role: "tool"` message.
 */
export async function runToolCall(
  client: Keenable,
  name: string,
  args: string | Record<string, unknown>,
): Promise<string> {
  const parsed = parseArguments(args);

  if (name === "keenable_search") {
    const query = requireString(parsed.query, "keenable_search needs a 'query'");
    const response = await client.search(query, {
      site: typeof parsed.site === "string" ? parsed.site : undefined,
      publishedAfter:
        typeof parsed.published_after === "string" ? parsed.published_after : undefined,
    });
    return response.toContext();
  }

  if (name === "keenable_fetch") {
    const url = requireString(parsed.url, "keenable_fetch needs a 'url'");
    const page = await client.fetch(url);
    return page.content;
  }

  throw new KeenableInvalidRequestError(`unknown Keenable tool: ${JSON.stringify(name)}`);
}
