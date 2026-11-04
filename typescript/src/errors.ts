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
 * when there was one, so structured fields stay reachable: a rejected domain
 * filter, for example, arrives as HTTP 400 with
 * `{ error: "invalid_filter", field, value, reason }`.
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
