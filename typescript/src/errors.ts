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
  readonly data?: Record<string, unknown>;
  readonly field?: string;
  readonly value?: string;
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
