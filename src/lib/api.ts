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
export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be JSON.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const text = await readCapped(request, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

/** Upper bound for JSON request bodies. Every current body is well under 1 KiB. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

const tooLarge = () => new AppError("VALIDATION_ERROR", "Request body is too large.");

/** Reads the body, aborting as soon as it exceeds maxBytes (Content-Length can be absent or wrong). */
async function readCapped(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
