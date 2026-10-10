export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

/** Error whose message is SAFE to show to users. Anything else is treated as internal. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

/**
 * Supabase/PostgREST errors are plain objects, which loggers render as "[object Object]".
 * Convert one into a real Error so server logs keep the code and message.
 * Internal only: never return this message to users.
 */
export function queryError(operation: string, error: { code?: string; message?: string }): Error {
  return new Error(`${operation} failed (${error.code ?? "unknown"}): ${error.message ?? "no message"}`);
}
