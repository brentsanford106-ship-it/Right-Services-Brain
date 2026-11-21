import type { ErrorCode } from "@rsb/contracts";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  internal_error: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: "Authentication required.",
  forbidden: "You do not have permission to perform this action.",
  not_found: "Not found.",
  validation_failed: "The request is invalid.",
  conflict: "The request conflicts with existing data.",
  rate_limited: "Too many requests. Please slow down.",
  payload_too_large: "The request is too large.",
  internal_error: "Something went wrong. Please try again.",
};

/** An error that is SAFE to show to the client. Never put internal details in `message`. */
export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: { path: string; issue: string }[],
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.status = STATUS[code];
  }
}

export const notFound = () => new HttpError("not_found");
export const forbidden = () => new HttpError("forbidden");
export const unauthenticated = () => new HttpError("unauthenticated");
