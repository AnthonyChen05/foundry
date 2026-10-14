/** Errors thrown by the SDK, normalized across WS and REST surfaces. */

export class FoundryError extends Error {
  /** Protocol error code on WS (`not_found`, `bad_request`, …); REST carries the OpenAI `error.type`. */
  code: string;
  /** HTTP status on REST calls (absent on WS). */
  status: number | undefined;
  /** Set when the failure is the SDK-side request timeout (safe to retry). */
  retryable: boolean | undefined;

  constructor(code: string, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "FoundryError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryable === true) this.retryable = true;
  }
}

/** Historical alias for WS request errors. */
export type WSRequestError = FoundryError;