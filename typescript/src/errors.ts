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

/** The Keenable API returned a non-2xx response. */
export class KeenableAPIError extends KeenableError {
  readonly statusCode: number;
  readonly body?: string;

  constructor(message: string, statusCode: number, body?: string) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
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
