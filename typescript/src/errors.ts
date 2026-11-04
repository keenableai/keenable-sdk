/** Errors thrown by the Keenable SDK. */

/** Base class for every error thrown by this SDK. */
export class KeenableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Keenable API could not be reached (DNS, TLS, timeout, ...). */
export class KeenableConnectionError extends KeenableError {}

/** The arguments passed to the SDK are invalid; no request was sent. */
export class KeenableInvalidRequestError extends KeenableError {}

/**
 * The Keenable API returned a non-2xx response.
 *
 * `body` is the API's error message. `data` is the decoded JSON error body
 * when it was a JSON object, so any field the API sends stays reachable.
 *
 * A rejected domain filter arrives as HTTP 400 with
 * `{ error: "invalid_filter", message: 'Invalid include_domains value "https://un.org": scheme is not allowed', field: "include_domains", value: "https://un.org", reason: "scheme is not allowed" }`.
 * For that body `field`, `value` and `reason` hold those keys, so code can
 * react to the rejected entry without parsing the message. They are
 * `undefined` on every other error.
 */
export class KeenableAPIError extends KeenableError {
  readonly statusCode: number;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  /** The rejected filter's name, e.g. `"include_domains"` (invalid_filter only). */
  readonly field?: string;
  /** The rejected entry as sent (invalid_filter only). */
  readonly value?: string;
  /** Why the API rejected it (invalid_filter only). */
  readonly reason?: string;

  constructor(
    message: string,
    statusCode: number,
    body?: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
    this.data = data;
    if (statusCode === 400 && data?.error === "invalid_filter") {
      this.field = text(data.field);
      this.value = text(data.value);
      this.reason = text(data.reason);
    }
  }
}

/** A structured error key as text: strings as is, other JSON re-encoded. */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The API key was rejected (HTTP 401/403). */
export class KeenableAuthError extends KeenableAPIError {}

/**
 * The rate limit was exceeded (HTTP 429).
 *
 * Keyless requests share a lower hourly cap. Setting `KEENABLE_API_KEY` lifts
 * it; a key is never required to make a request.
 */
export class KeenableRateLimitError extends KeenableAPIError {}
