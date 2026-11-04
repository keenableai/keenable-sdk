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
 * when it was a JSON object, so any field the API sends stays reachable. A
 * rejected domain filter arrives as HTTP 400 with
 * `{ error: "Bad request", message: 'Invalid include_domains value "https://un.org": scheme is not allowed' }`:
 * the field, entry and reason are in the message (also on `body`), not in
 * separate keys.
 */
export class KeenableAPIError extends KeenableError {
  readonly statusCode: number;
  readonly body?: string;
  readonly data?: Record<string, unknown>;

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
  }
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
