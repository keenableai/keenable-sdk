/**
 * Ready-made tool definitions for tool calling, in three formats.
 *
 * `TOOLS` is the OpenAI-compatible Chat Completions shape that most inference
 * APIs (Cerebras, OpenAI, Mistral, Ollama, vLLM and anything speaking the same
 * schema) take, so it can be passed straight into a
 * `chat.completions.create({ tools })` call. `ANTHROPIC_TOOLS` is the same two
 * tools in the Anthropic Messages shape and `GEMINI_TOOLS` in the Gemini
 * Interactions API shape. `runToolCall` takes a call from any of them.
 */

import { DEFAULT_CONTEXT_MAX_CHARS, type FetchError, type Keenable, type Page } from "./client.js";
import { KeenableAPIError, KeenableInvalidRequestError } from "./errors.js";
import { type Filter, TOOL_FILTERS, toolProperties } from "./filters.js";
import { nonEmpty } from "./internal.js";
import type { FetchOptions, SearchOptions } from "./types.js";

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
      "Fetch up to 20 web pages and return each one's main content as markdown. " +
      "Use after keenable_search when a search snippet is not enough. Add a prompt " +
      "to get back only the part you need from long pages.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "The URLs of the pages to read, 1 to 20.",
        },
        max_chars: {
          type: "integer",
          minimum: 1,
          description: "The most characters of content to return for each page.",
        },
        prompt: {
          type: "string",
          description:
            "An instruction applied to every page; each page's content is then only " +
            "the answer to it. Use it to get one detail from long pages.",
        },
        max_age_hours: {
          type: "number",
          minimum: -1,
          maximum: 720,
          description:
            "How old Keenable's stored copy may be, in hours; an older copy is read " +
            "again from the source. 0 reads every page live. -1 reads only the stored " +
            "copy, never the live page; other negative values are refused.",
        },
      },
      required: ["urls"],
    },
  },
};

export const TOOLS: ToolDefinition[] = [SEARCH_TOOL, FETCH_TOOL];

/** A tool in the Anthropic Messages API shape: the schema goes under `input_schema`. */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A function tool in the Gemini Interactions API shape: flat, with `type: "function"`. */
export interface GeminiToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * `TOOLS` in the Anthropic Messages API shape, for `messages.create({ tools })`.
 * Pass each `tool_use` block's `name` and `input` to `runToolCall`.
 */
export const ANTHROPIC_TOOLS: AnthropicToolDefinition[] = TOOLS.map(({ function: fn }) => ({
  name: fn.name,
  description: fn.description,
  input_schema: fn.parameters,
}));

/**
 * `TOOLS` in the Gemini Interactions API shape, for `interactions.create({ tools })`.
 * Pass each `function_call` step's `name` and `arguments` to `runToolCall`.
 * For `generateContent`, drop `type` and pass the rest as `functionDeclarations`.
 */
export const GEMINI_TOOLS: GeminiToolDefinition[] = TOOLS.map(({ function: fn }) => ({
  type: "function",
  name: fn.name,
  description: fn.description,
  parameters: fn.parameters,
}));

function parseArguments(args: unknown): Record<string, unknown> {
  // An array is `typeof "object"` but carries no named arguments, so let it
  // fall through to the same rejection a JSON array gets below.
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args !== "string") {
    throw new KeenableInvalidRequestError(
      `tool call arguments must be a JSON string or an object, got ${typeof args}`,
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

// A model's null and "" are unset; search() would send a list filter's "" as [""].
function toolValue(filter: Filter, value: unknown): unknown {
  // false is the default. search() rejects anything but a boolean.
  if (filter.jsonType === "boolean") {
    return value === false || value === "" || value === null ? undefined : value;
  }
  if (filter.enum && value !== null && value !== undefined && typeof value !== "string") {
    const choices = filter.enum.map((v) => `"${v}"`).join(" or ");
    throw new KeenableInvalidRequestError(`${filter.wire} must be ${choices}. Pass a JSON string, or leave it out.`);
  }
  if (filter.jsonType !== "array") return nonEmpty(value);
  return value === "" || value === null ? undefined : value;
}

/** Keep only the filters the tool schema actually offers the model. */
function toolFilterOptions(args: Record<string, unknown>): SearchOptions {
  const options: Record<string, unknown> = {};
  for (const filter of TOOL_FILTERS) {
    const value = toolValue(filter, args[filter.wire]);
    if (value !== undefined) options[filter.option] = value;
  }
  return options as SearchOptions;
}

const FETCH_TOOL_OPTIONS = [
  ["max_chars", "maxChars"],
  ["prompt", "prompt"],
  ["max_age_hours", "maxAgeHours"],
] as const;

/** The `urls` a model sent: 1 to 20 non-blank strings. */
function fetchUrls(args: Record<string, unknown>): string[] {
  const raw = args.urls;
  const urls: unknown = typeof raw === "string" ? [raw] : raw;
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    !urls.every((url) => nonEmpty(url) !== undefined)
  ) {
    throw new KeenableInvalidRequestError("keenable_fetch needs 'urls': a list of 1 to 20 URLs");
  }
  return urls as string[];
}

function pageError(e: FetchError): KeenableAPIError {
  const { message, error, status, ...details } = e;
  return new KeenableAPIError(message ?? error, status, undefined, { error, ...details });
}

/**
 * Each page as a numbered, citable block and a failed URL as an error block;
 * thrown only when no URL could be read.
 */
function pagesContext(pages: Page[], maxChars: unknown): string {
  if (pages.length === 0) {
    throw new KeenableAPIError("the Keenable API returned no result for the URL", 200);
  }
  const failed = pages.filter((page) => page.error);
  if (failed.length === pages.length && failed[0]?.error) throw pageError(failed[0].error);
  // The API already cut each page to max_chars; leave room for its header.
  // Without max_chars, the default budget is split across the pages.
  const budget =
    typeof maxChars === "number" && Number.isInteger(maxChars)
      ? maxChars + 1_000
      : Math.max(Math.floor(DEFAULT_CONTEXT_MAX_CHARS / pages.length), 1_000);
  return pages
    .map((page, i) => {
      if (!page.error) {
        return `[${i + 1}]${page.toContext({ maxChars: budget }).slice("[1]".length)}`;
      }
      const message = page.error.message ?? page.error.error ?? "the page could not be read";
      return `[${i + 1}] ${page.url} - failed: ${message}`;
    })
    .join("\n\n");
}

/**
 * Execute one tool call and return the string to send back as the result.
 *
 * Pass the tool name and arguments straight from the model's response: the
 * JSON string of an OpenAI-compatible `function.arguments`, or the decoded
 * object of an Anthropic `tool_use` block's `input` or a Gemini
 * `function_call`'s `arguments`. `args` is `unknown` so those pass without a
 * cast; anything but a JSON object string or an object throws
 * `KeenableInvalidRequestError`. The return value is ready to send back as the
 * tool result (a `role: "tool"` message, a `tool_result` block, a
 * `function_result`), rendered as the same numbered, citable block for both tools. A URL that failed while others
 * were read becomes an error block; if none was read, its error is thrown.
 */
export async function runToolCall(
  client: Keenable,
  name: string,
  args: unknown,
): Promise<string> {
  const parsed = parseArguments(args);

  if (name === "keenable_search") {
    const query = requireString(parsed.query, "keenable_search needs a 'query'");
    const response = await client.search(query, toolFilterOptions(parsed));
    return response.toContext();
  }

  if (name === "keenable_fetch") {
    const options: Record<string, unknown> = {};
    for (const [wire, option] of FETCH_TOOL_OPTIONS) {
      const value = parsed[wire];
      if (value !== undefined && value !== null && value !== "") options[option] = value;
    }
    const response = await client.fetch(fetchUrls(parsed), options as FetchOptions);
    return pagesContext(response.results, options.maxChars);
  }

  throw new KeenableInvalidRequestError(`unknown Keenable tool: ${JSON.stringify(name)}`);
}
