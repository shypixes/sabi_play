import { describe, expect, it } from "vitest";
import { MAX_JSON_BODY_BYTES, readJsonBody } from "@/lib/api";

// UNIT: request body limits of the shared JSON reader used by every mutating API route.

const req = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("http://localhost/api/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

describe("readJsonBody", () => {
  it("parses normal JSON bodies", async () => {
    expect(await readJsonBody(req(JSON.stringify({ format: "SCORE_ATTACK", score: 1 })))).toEqual({ format: "SCORE_ATTACK", score: 1 });
  });

  it("refuses bodies over the limit, by Content-Length and by actual size", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_JSON_BODY_BYTES) });
    await expect(readJsonBody(req(big))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Request body is too large." });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024)));
        c.close();
      },
    });
    await expect(readJsonBody(req(stream, { "content-type": "application/json", "content-length": "2" })))
      .rejects.toMatchObject({ message: "Request body is too large." });
  });

  it("still requires a JSON content type and valid JSON", async () => {
    await expect(readJsonBody(req("{}", { "content-type": "text/plain" }))).rejects.toMatchObject({ message: "Request body must be JSON." });
    await expect(readJsonBody(req("{nope"))).rejects.toMatchObject({ message: "Request body must be valid JSON." });
    await expect(readJsonBody(req(null))).rejects.toMatchObject({ message: "Request body must be valid JSON." });
  });
});
