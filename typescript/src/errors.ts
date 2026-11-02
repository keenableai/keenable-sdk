/**
 * Errors thrown by the Keenable SDK.
 *
 * Every error extends `KeenableError`. Errors from the API itself extend
 * `KeenableAPIError` and are picked by HTTP status:
 *
 * | Status   | Error                      | Meaning                          |
 * |----------|----------------------------|----------------------------------|
 * | 400, 422 | `KeenableValidationError`  | A parameter was rejected         |
 * | 401      | `KeenableAuthError`        | The API key is missing/invalid   |
 * | 402      | `KeenableCreditsError`     | The account is out of credits    |
 * | 403      | `KeenableForbiddenError`   | The key or tier may not do this  |
 * | 429      | `KeenableRateLimitError`   | The rate limit was exceeded      |
 *
 * `KeenableInvalidRequestError` is different: the SDK rejected the arguments
 * itself and no request was sent.
 */

/** Base class for every error thrown by this SDK. */
export class KeenableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The Keenable API could not be reached (DNS, TLS, timeout, ...).
 *
 * Search and fetch have no side effects, so retrying is safe.
 */
export class KeenableConnectionError extends KeenableError {}

/** The arguments passed to the SDK are invalid; no request was sent. */
export class KeenableInvalidRequestError extends KeenableError {}

/** Structured fields the API attached to an error response. */
export interface KeenableAPIErrorFields {
  /** The API's short error label, e.g. `"Invalid parameter"`. */
  apiError?: string;
  /** Any structured `details` the API attached, unmodified. */
  details?: unknown;
  /** The `X-Request-Id` of the failed request. Quote it to support. */
  requestId?: string;
  /**
   * The one-line next step that ends the message. Exposed separately so a
   * harness can drop it before showing the error to a model.
   */
  hint?: string;
}

/** The Keenable API returned a non-2xx response. */
export class KeenableAPIError extends KeenableError {
  /** The HTTP status. */
  readonly statusCode: number;
  /** The API's human-readable error message, when it sent one. */
  readonly body?: string;
  readonly apiError?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly hint?: string;

  constructor(
    message: string,
    statusCode: number,
    body?: string,
    fields: KeenableAPIErrorFields = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
    this.apiError = fields.apiError;
    this.details = fields.details;
    this.requestId = fields.requestId;
    this.hint = fields.hint;
  }
}

/**
 * The API rejected the request (HTTP 400 or 422). `body` says what was
 * rejected, usually naming the parameter; retrying unchanged fails the same way.
 */
export class KeenableValidationError extends KeenableAPIError {}

/**
 * The API key is missing or was rejected (HTTP 401).
 *
 * `KeenableForbiddenError` (403) extends this, so existing
 * `instanceof KeenableAuthError` checks keep matching both.
 */
export class KeenableAuthError extends KeenableAPIError {}

/**
 * The request is not allowed for this caller (HTTP 403): typically a mode or
 * feature that needs an API key, or a plan that includes it.
 */
export class KeenableForbiddenError extends KeenableAuthError {}

/**
 * The account has no credits left (HTTP 402). Retrying will not help until
 * credits are added.
 */
export class KeenableCreditsError extends KeenableAPIError {}

/** Rate-limit headers the API sent with a 429. */
export interface RateLimitFields {
  /** `X-RateLimit-Limit`. */
  limit?: number;
  /** `X-RateLimit-Remaining`. */
  remaining?: number;
  /** `X-RateLimit-Reset`: ISO-8601 time the window reopens. */
  reset?: string;
}

/**
 * The rate limit was exceeded (HTTP 429).
 *
 * Keyless requests share a lower hourly cap. Setting `KEENABLE_API_KEY` lifts
 * it; a key is never required to make a request.
 */
export class KeenableRateLimitError extends KeenableAPIError {
  readonly limit?: number;
  readonly remaining?: number;
  readonly reset?: string;

  constructor(
    message: string,
    statusCode: number,
    body?: string,
    fields: KeenableAPIErrorFields & RateLimitFields = {},
  ) {
    super(message, statusCode, body, fields);
    this.limit = fields.limit;
    this.remaining = fields.remaining;
    this.reset = fields.reset;
  }
}
