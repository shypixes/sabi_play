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

/**
 * Reads a JSON request body for a mutating route. Requiring `application/json` means a
 * cross-site HTML form cannot trigger the route (that content type forces a CORS preflight),
 * which complements SameSite session cookies. Validate the returned value with zod.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be JSON.");
  }
  try {
    return await request.json();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.");
  }
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
