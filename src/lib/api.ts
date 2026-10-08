import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { logger, type LogContext } from "@/lib/logger";

/**
 * Standard response envelope:
 *   success: { ok: true,  data }
 *   failure: { ok: false, error: { code, message, details? } }
 */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(err: unknown, ctx: LogContext = {}) {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid input.", details: err.flatten().fieldErrors } },
      { status: 400 },
    );
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message, ctx, err);
    return NextResponse.json(
      { ok: false, error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  logger.error("Unhandled error", ctx, err);
  return NextResponse.json(
    { ok: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong." } },
    { status: 500 },
  );
}
