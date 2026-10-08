import { ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export function GET() {
  return ok({ status: "up", time: new Date().toISOString() });
}
