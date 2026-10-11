import { describe, expect, it, vi } from "vitest";
import {
  TEST_PANEL_CONFIG_ID,
  buildPanelRequest,
  canStart,
  displayBody,
  extractSessionId,
  extractSessionStatus,
  runPanelRequest,
  summarize,
  type PanelResult,
} from "@/app/(app)/test-panel/panel-requests";

// UNIT: TEMPORARY test panel request/response handling with a fake fetch (no network).
// Remove together with src/app/(app)/test-panel.

const SESSION = "11111111-1111-4111-8111-111111111111";

function fakeFetch(status: number, body: unknown, raw?: string) {
  return vi.fn<typeof fetch>(async () =>
    new Response(raw ?? JSON.stringify(body), { status, headers: { "content-type": raw ? "text/html" : "application/json" } }),
  );
}
const envelopeError = (code: string, message: string, details?: unknown) => ({ ok: false, error: { code, message, details } });
const sessionBody = (o: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    session: {
      sessionId: SESSION, configId: TEST_PANEL_CONFIG_ID, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE",
      status: "READY", validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED", yourSlot: 1, ...o,
    },
  },
});

describe("request building", () => {
  it("create sends exactly the specified same-origin JSON request with only the config id", () => {
    const r = buildPanelRequest("create");
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/api/competitions/sessions");
    expect(JSON.parse(r.body ?? "")).toEqual({ configId: "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac" });
    expect(r.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(r.init.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("never sends a user id, token or authorization header", () => {
    for (const r of [buildPanelRequest("create"), buildPanelRequest("refresh", SESSION), buildPanelRequest("cancel", SESSION), buildPanelRequest("whoami")]) {
      const serialized = JSON.stringify(r).toLowerCase();
      expect(serialized).not.toMatch(/user_?id|authorization|bearer|token|service|apikey/);
      expect(r.url.startsWith("/api/")).toBe(true); // relative: same origin only
    }
  });

  it("refresh is a GET and cancel posts {} to the session's cancel route", () => {
    expect(buildPanelRequest("refresh", SESSION)).toMatchObject({ method: "GET", url: `/api/competitions/sessions/${SESSION}`, body: null });
    expect(buildPanelRequest("cancel", SESSION)).toMatchObject({ method: "POST", url: `/api/competitions/sessions/${SESSION}/cancel`, body: "{}" });
  });

  it("refuses refresh/cancel without a valid session id (no request built)", () => {
    expect(() => buildPanelRequest("refresh", null)).toThrow();
    expect(() => buildPanelRequest("cancel", "../../wallet")).toThrow();
  });
});

describe("running requests", () => {
  it("calls fetch once with the built request and reports the real status and body", async () => {
    const f = fakeFetch(201, sessionBody());
    const r = await runPanelRequest("create", null, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toBe("/api/competitions/sessions");
    expect(r).toMatchObject({ kind: "response", httpStatus: 201, httpOk: true, isJson: true });
    expect(extractSessionId(r)).toBe(SESSION);
    expect(summarize(r)).toMatchObject({ tone: "success", title: "Practice session created (HTTP 201)" });
    expect(summarize(r).details).toContain("Settlement: NOT_REQUIRED");
    expect(displayBody(r)).toBe(JSON.stringify(sessionBody(), null, 2));
  });

  it("reports network failures as failures, never as success", async () => {
    const f = vi.fn<typeof fetch>(async () => { throw new TypeError("Load failed"); });
    const r = await runPanelRequest("create", null, f);
    expect(r.kind).toBe("network-error");
    expect(summarize(r)).toMatchObject({ tone: "error", title: "Request did not reach the server" });
    expect(summarize(r).details).toContain("Load failed");
    expect(extractSessionId(r)).toBeNull();
  });

  it("shows non-JSON responses raw and flags them as errors", async () => {
    const r = await runPanelRequest("create", null, fakeFetch(502, null, "<html>Bad gateway</html>"));
    expect(summarize(r)).toMatchObject({ tone: "error", title: "Unexpected response (HTTP 502)" });
    expect(displayBody(r)).toBe("<html>Bad gateway</html>");
  });

  it("does not treat a 2xx with an error envelope or odd shape as success", async () => {
    const r = await runPanelRequest("create", null, fakeFetch(200, { ok: false, error: { code: "X", message: "nope" } }));
    expect(summarize(r).tone).toBe("error");
    const odd = await runPanelRequest("create", null, fakeFetch(200, { hello: "world" }));
    expect(summarize(odd).tone).toBe("error");
    expect(extractSessionId(odd)).toBeNull();
  });
});

describe("error explanations", () => {
  const cases: [number, unknown, RegExp][] = [
    [401, envelopeError("UNAUTHENTICATED", "You need to log in."), /not signed in/i],
    [409, envelopeError("CONFLICT", "This competition is not open right now."), /DISABLED.*SQL editor/i],
    [409, envelopeError("CONFLICT", "This game is not available."), /does not register test-game/i],
    [409, envelopeError("CONFLICT", "Finish or cancel an open session first."), /3 open sessions/i],
    [403, envelopeError("FORBIDDEN", "Paid competitions are not available yet."), /PAID/],
    [403, envelopeError("FORBIDDEN", "Your player profile is not set up."), /no profile row/i],
    [404, envelopeError("NOT_FOUND", "Competition not found."), /configuration was not found/i],
    [400, envelopeError("VALIDATION_ERROR", "Invalid input.", { configId: ["Invalid uuid"] }), /rejected the request/i],
    [500, envelopeError("INTERNAL_ERROR", "Something went wrong."), /Vercel function logs/i],
  ];
  it.each(cases)("HTTP %i is shown as a failure with the server message and a hint", async (status, body, hint) => {
    const r = await runPanelRequest("create", null, fakeFetch(status, body));
    const s = summarize(r);
    expect(s.tone).toBe("error");
    expect(s.title).toContain(`HTTP ${status}`);
    expect(s.details[0]).toBe((body as { error: { message: string } }).error.message);
    expect(s.details.join(" ")).toMatch(hint);
    expect(extractSessionId(r)).toBeNull();
    expect(displayBody(r)).toContain((body as { error: { code: string } }).error.code); // complete body shown
  });

  it("session-level 404s are explained differently from config 404s", async () => {
    const r = await runPanelRequest("refresh", SESSION, fakeFetch(404, envelopeError("NOT_FOUND", "Session not found.")));
    expect(summarize(r).details.join(" ")).toMatch(/Session not found/);
  });
});

describe("refresh and cancel", () => {
  it("refresh reports the current session state without creating anything", async () => {
    const f = fakeFetch(200, sessionBody({ status: "IN_PROGRESS" }));
    const r: PanelResult = await runPanelRequest("refresh", SESSION, f);
    expect(f.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(summarize(r)).toMatchObject({ tone: "success", title: "Session loaded (HTTP 200)" });
    expect(summarize(r).details).toContain("Status: IN_PROGRESS");
  });

  it("cancel reports the new status from the server", async () => {
    const r = await runPanelRequest("cancel", SESSION, fakeFetch(200, sessionBody({ status: "CANCELLED" })));
    expect(summarize(r)).toMatchObject({ tone: "success", title: "Session cancelled (HTTP 200)" });
    expect(summarize(r).details).toContain("Status: CANCELLED");
  });
});

describe("start", () => {
  it("posts {} as JSON to the session's start route, same-origin, with no identity", () => {
    const r = buildPanelRequest("start", SESSION);
    expect(r).toMatchObject({ method: "POST", url: `/api/competitions/sessions/${SESSION}/start`, body: "{}" });
    expect(r.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: "{}" });
    expect(r.init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.stringify(r).toLowerCase()).not.toMatch(/user_?id|authorization|bearer|token/);
  });

  it("refuses to build a start request without a valid session id", () => {
    expect(() => buildPanelRequest("start", null)).toThrow();
    expect(() => buildPanelRequest("start", "not-a-uuid")).toThrow();
  });

  it("canStart only for a valid session id whose last status is READY", () => {
    expect(canStart(SESSION, "READY")).toBe(true);
    expect(canStart(null, "READY")).toBe(false);
    expect(canStart("not-a-uuid", "READY")).toBe(false);
    for (const status of [null, "WAITING", "IN_PROGRESS", "SUBMITTED", "COMPLETED", "CANCELLED", "ABANDONED", "ready"]) {
      expect(canStart(SESSION, status)).toBe(false);
    }
  });

  it("successful start: status, start time and deadline are read from the real response", async () => {
    const f = fakeFetch(200, sessionBody({ status: "IN_PROGRESS", startedAt: "2026-10-11T12:00:00Z", deadlineAt: "2026-10-11T12:03:30Z" }));
    const r = await runPanelRequest("start", SESSION, f);
    expect(f.mock.calls[0]?.[0]).toBe(`/api/competitions/sessions/${SESSION}/start`);
    expect(extractSessionStatus(r)).toBe("IN_PROGRESS");
    const s = summarize(r);
    expect(s).toMatchObject({ tone: "success", title: "Session started (HTTP 200)" });
    expect(s.details).toEqual(expect.arrayContaining(["Status: IN_PROGRESS", "Started: 2026-10-11T12:00:00Z", "Deadline: 2026-10-11T12:03:30Z"]));
  });

  it("failed start (409 invalid state) gets a start-specific explanation and no status", async () => {
    const r = await runPanelRequest("start", SESSION, fakeFetch(409, envelopeError("CONFLICT", "That action is not allowed in the session's current state.")));
    const s = summarize(r);
    expect(s.tone).toBe("error");
    expect(s.title).toBe("Request failed (HTTP 409 CONFLICT)");
    expect(s.details.join(" ")).toMatch(/Start only works while the session is READY/);
    expect(extractSessionStatus(r)).toBeNull();
    expect(extractSessionId(r)).toBeNull();
  });

  it("failed start (404, network) never yields a status", async () => {
    const nf = await runPanelRequest("start", SESSION, fakeFetch(404, envelopeError("NOT_FOUND", "Session not found.")));
    expect(summarize(nf).tone).toBe("error");
    expect(extractSessionStatus(nf)).toBeNull();
    const net = await runPanelRequest("start", SESSION, vi.fn<typeof fetch>(async () => { throw new TypeError("Load failed"); }));
    expect(extractSessionStatus(net)).toBeNull();
  });
});

