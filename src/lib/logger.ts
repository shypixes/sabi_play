import "server-only";

const REDACT = /pass(word)?|secret|token|authorization|api[-_]?key|cookie|service[-_]?role/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      REDACT.test(k) ? "[REDACTED]" : redact(v, depth + 1),
    ]),
  );
}

export type LogContext = {
  userId?: string;
  action?: string;
  recordId?: string;
  [key: string]: unknown;
};

function emit(level: "info" | "warn" | "error", message: string, ctx: LogContext = {}, err?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(redact(ctx) as object),
    ...(err ? { error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) } : {}),
  };
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(JSON.stringify(line));
}

export const logger = {
  info: (m: string, c?: LogContext) => emit("info", m, c),
  warn: (m: string, c?: LogContext) => emit("warn", m, c),
  error: (m: string, c?: LogContext, e?: unknown) => emit("error", m, c, e),
};
