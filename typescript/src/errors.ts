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

/**
 * The Keenable API did not answer within the deadline (`timeoutMs`). A
 * `KeenableConnectionError`, so code that catches that keeps working.
 */
export class KeenableTimeoutError extends KeenableConnectionError {}

/** The arguments passed to the SDK are invalid; no request was sent. */
export class KeenableInvalidRequestError extends KeenableError {}

/**
 * The limit a 429 hit, from the API's `limit` object. A field the API left out
 * is `undefined`.
 */
export interface RateLimitInfo {
  /** Who the limit counts: `"organization"`, `"ip"`, `"payer"` or `"agent"`. */
  scope?: string;
  /** The window length: `"second"` or `"hour"`. */
  window?: string;
  /** Requests allowed per window. */
  max?: number;
  /** ISO 8601 time when the window opens again. */
  resetsAt?: string;
}

/**
 * The category of an API error. Branch on it for coarse handling and on `code`
 * for the exact reason. A newer API may send a type not listed here, so the
 * field also accepts any string.
 */
export type KeenableErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "billing_error"
  | "rate_limit_error"
  /** The page being fetched failed, not Keenable. */
  | "target_error"
  | "api_error";

/**
 * The agent-ready fields of an API error body. Each is `undefined` when the API
 * did not send it, which is the case for older responses.
 */
export interface KeenableAPIErrorDetails {
  /** Stable, machine-readable reason, e.g. `"rate_limit_per_second"`. Branch on this, not on the message. */
  code?: string;
  /**
   * The error's category. Derived from the status and `code` when the API did
   * not send it, so it is set on every response error.
   */
  type?: KeenableErrorType | (string & {});
  /** The API's short error title, e.g. `"Rate limit exceeded"`. */
  error?: string;
  /** One sentence on what to do next. */
  fix?: string;
  /** Whether sending the same request again can succeed. */
  retryable?: boolean;
  /** Seconds to wait before retrying: the body's `retry_after_seconds`, else the `Retry-After` header. */
  retryAfterSeconds?: number;
  /** Quote it when reporting a problem: the body's `request_id`, else the `X-Request-Id` header. */
  requestId?: string;
  /** The request parameter a 400 is about. */
  param?: string;
  /** The limit a 429 hit. */
  limit?: RateLimitInfo;
  /** The entry a 400 `invalid_filter` error rejected, such as one `excludeDomains` host; `param` names its parameter. */
  value?: string;
  /** Why the API rejected `value`. */
  reason?: string;
}

/**
 * The Keenable API returned a non-2xx response. The message ends with
 * `(code: <code>)` and `(request_id: <requestId>)` when the API sent them.
 */
export class KeenableAPIError extends KeenableError implements KeenableAPIErrorDetails {
  readonly statusCode: number;
  readonly body?: string;
  readonly code?: string;
  readonly type?: KeenableErrorType | (string & {});
  readonly error?: string;
  readonly fix?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;
  readonly param?: string;
  readonly limit?: RateLimitInfo;
  readonly value?: string;
  readonly reason?: string;

  constructor(
    message: string,
    statusCode: number,
    body?: string,
    details: KeenableAPIErrorDetails = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
    this.code = details.code;
    this.type = details.type;
    this.error = details.error;
    this.fix = details.fix;
    this.retryable = details.retryable;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.requestId = details.requestId;
    this.param = details.param;
    this.limit = details.limit;
    this.value = details.value;
    this.reason = details.reason;
  }
}

/** The API key was rejected (HTTP 401/403). */
export class KeenableAuthError extends KeenableAPIError {}

/**
 * The rate limit was exceeded (HTTP 429).
 *
 * Keyless requests share a lower hourly cap. Setting `KEENABLE_API_KEY` lifts
 * it; a key is never required to make a request. Wait `retryAfterSeconds`
 * before retrying; `limit` says which limit was hit.
 */
export class KeenableRateLimitError extends KeenableAPIError {}

/**
 * The organization has no credits left, or the API asked for a payment this
 * SDK cannot make (HTTP 402).
 *
 * Retrying returns the same error until a human with console access adds
 * credits. The SDK does not expose billing, checkout or payment-offer details.
 */
export class KeenableInsufficientCreditsError extends KeenableAPIError {}

/** Alias of {@link KeenableInsufficientCreditsError}, the name the docs use. */
export const KeenableCreditsError = KeenableInsufficientCreditsError;
/** Alias of {@link KeenableInsufficientCreditsError}, the name the docs use. */
export type KeenableCreditsError = KeenableInsufficientCreditsError;
