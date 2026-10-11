// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestPanel } from "@/app/(app)/test-panel/TestPanel";
import type { TestConfigSummary } from "@/app/(app)/test-panel/load-config";
import type { MySessions } from "@/app/(app)/test-panel/load-sessions";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// UNIT (simulated browser DOM via jsdom): the TEMPORARY test panel's tap handling with a fake
// fetch. Not a real browser or a real network. Remove together with src/app/(app)/test-panel.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "11111111-1111-4111-8111-111111111111";
const CONFIG: TestConfigSummary = {
  state: "found", label: "Test practice", gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE",
  entryFee: 0, timeLimitSeconds: 180, enabled: true,
};
const NO_SESSIONS: MySessions = { state: "ok", rows: [], openCount: 0, maxOpen: 3, shownLimit: 50, loadedAt: "2026-10-11T12:00:00Z" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const created = (status = "READY") => json(201, {
  ok: true,
  data: { session: { sessionId: SESSION, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status, validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED" } },
});

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();

function button(label: string): HTMLButtonElement {
  const b = [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  if (!b) throw new Error(`button "${label}" not found; have: ${[...container.querySelectorAll("button")].map((x) => x.textContent).join(", ")}`);
  return b;
}
const text = () => container.textContent ?? "";
async function tap(label: string) {
  await act(async () => { button(label).click(); });
}
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(TestPanel, { email: "tester@example.com", config: CONFIG, registryReady: true, sessions: NO_SESSIONS })); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("test panel interactions", () => {
  it("sends nothing when the page loads (after effects run)", () => {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text()).toContain("No request sent yet.");
  });

  it("shows a loading state, disables the button and ignores repeated taps while pending", async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.promise);
    await tap("Create Practice Session");
    expect(button("Creating…").disabled).toBe(true);
    expect(text()).toContain("Creating practice session…");
    expect(button("Refresh session").disabled).toBe(true);
    // Repeated taps while pending (disabled button + in-flight guard).
    await act(async () => { button("Creating…").click(); button("Creating…").click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { d.resolve(created()); });
    expect(button("Create Practice Session").disabled).toBe(false);
    expect(text()).toContain("Practice session created (HTTP 201)");
    expect(text()).toContain("HTTP status201");
    expect(text()).toContain(`"sessionId": "${SESSION}"`);
    expect(text()).toContain("Sessions created from this page since it loaded: 1");
    expect(button("Refresh session").disabled).toBe(false);
  });

  it("two taps in the same instant still send one request", async () => {
    const d = deferred();
    fetchMock.mockReturnValue(d.promise);
    await act(async () => {
      button("Create Practice Session").click();
      button("Create Practice Session").click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve(created()); });
  });

  it("sends the exact create request", async () => {
    fetchMock.mockResolvedValueOnce(created());
    await tap("Create Practice Session");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/competitions/sessions");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ configId: "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac" }) });
  });

  it("shows failures with status, server message, hint and full body, and does not count them", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: { code: "CONFLICT", message: "This competition is not open right now." } }));
    await tap("Create Practice Session");
    expect(text()).toContain("Request failed (HTTP 409 CONFLICT)");
    expect(text()).toContain("This competition is not open right now.");
    expect(text()).toContain("DISABLED");
    expect(text()).toContain("HTTP status409");
    expect(text()).toContain('"code": "CONFLICT"');
    expect(text()).not.toContain("Sessions created from this page");
    expect(button("Refresh session").disabled).toBe(true); // no session to refresh
  });

  it("shows network failures without claiming success", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Load failed"));
    await tap("Create Practice Session");
    expect(text()).toContain("Request did not reach the server");
    expect(text()).toContain("none (no response)");
    expect(text()).not.toContain("created (HTTP");
  });

  it("Clear removes the result without any request; Refresh reloads without creating", async () => {
    fetchMock.mockResolvedValueOnce(created());
    await tap("Create Practice Session");
    await tap("Clear result");
    expect(text()).toContain("No request sent yet.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { session: { sessionId: SESSION, status: "READY" } } }));
    await tap("Refresh session");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/competitions/sessions/${SESSION}`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls.filter(([u, i]) => u === "/api/competitions/sessions" && i?.method === "POST")).toHaveLength(1);
    expect(text()).toContain("Session loaded (HTTP 200)");
  });

  it("Cancel asks for confirmation and only then posts to the cancel route", async () => {
    fetchMock.mockResolvedValueOnce(created());
    await tap("Create Practice Session");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await tap("Cancel session");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(true);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { session: { sessionId: SESSION, status: "CANCELLED" } } }));
    await tap("Cancel session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/competitions/sessions/${SESSION}/cancel`);
    expect(text()).toContain("Session cancelled (HTTP 200)");
  });

  it("Check sign-in calls /api/me and reports the real status", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "You need to log in." } }));
    await tap("Check sign-in with server");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/me");
    expect(text()).toContain("Request failed (HTTP 401 UNAUTHENTICATED)");
  });
});

describe("Start Session", () => {
  const sessionJson = (status: string, extra: Record<string, unknown> = {}) => json(200, {
    ok: true,
    data: { session: { sessionId: SESSION, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status, validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED", ...extra } },
  });
  const startedJson = () => sessionJson("IN_PROGRESS", { startedAt: "2026-10-11T12:00:00Z", deadlineAt: "2026-10-11T12:03:30Z" });
  const calls = (method: string, url: string) =>
    fetchMock.mock.calls.filter(([u, i]) => u === url && (i?.method ?? "GET") === method).length;
  const CREATE = "/api/competitions/sessions";
  const START = `/api/competitions/sessions/${SESSION}/start`;
  const DETAILS = `/api/competitions/sessions/${SESSION}`;

  async function createReady() {
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
  }

  it("is disabled until a session exists", () => {
    expect(button("Start Session").disabled).toBe(true);
    expect(text()).toContain("Create a session first.");
  });

  it("is enabled for a READY session and sends the exact start request", async () => {
    await createReady();
    expect(button("Start Session").disabled).toBe(false);
    fetchMock.mockResolvedValueOnce(startedJson()).mockResolvedValueOnce(startedJson());
    await tap("Start Session");
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe(START);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: "{}" });
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("successful start: shows the start response, then refreshes the session details automatically", async () => {
    await createReady();
    const startD = deferred();
    const refreshD = deferred();
    fetchMock.mockReturnValueOnce(startD.promise).mockReturnValueOnce(refreshD.promise);

    await tap("Start Session");
    expect(button("Starting…").disabled).toBe(true);
    expect(button("Create Practice Session").disabled).toBe(true);
    expect(text()).toContain("Starting session…");

    await act(async () => { startD.resolve(startedJson()); });
    // Refresh is requested only after the start succeeded; still busy meanwhile.
    expect(calls("GET", DETAILS)).toBe(1);
    expect(text()).toContain("Session started. Refreshing session details…");
    expect(button("Starting…").disabled).toBe(true);

    await act(async () => { refreshD.resolve(startedJson()); });
    expect(text()).toContain("Step 1 of 2: Start");
    expect(text()).toContain("Session started (HTTP 200)");
    expect(text()).toContain("Step 2 of 2: Refresh");
    expect(text()).toContain("Session loaded (HTTP 200)");
    expect(text()).toContain("Deadline: 2026-10-11T12:03:30Z");
    expect(text()).toContain('"status": "IN_PROGRESS"');
    expect(text()).toContain("Status (last reported)IN_PROGRESS");
    // Now not READY: Start is disabled and explains why.
    expect(button("Start Session").disabled).toBe(true);
    expect(text()).toContain("Start needs status READY; this session is IN_PROGRESS");
    // Exactly one create, one start, one refresh. No session was created by Start.
    expect(calls("POST", CREATE)).toBe(1);
    expect(calls("POST", START)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores repeated and simultaneous taps while the start is running", async () => {
    await createReady();
    const startD = deferred();
    fetchMock.mockReturnValueOnce(startD.promise).mockResolvedValueOnce(startedJson());
    await act(async () => {
      button("Start Session").click();
      button("Start Session").click();
    });
    await act(async () => { button("Starting…").click(); });
    expect(calls("POST", START)).toBe(1);
    await act(async () => { startD.resolve(startedJson()); });
    expect(calls("POST", START)).toBe(1);
    expect(calls("GET", DETAILS)).toBe(1);
  });

  it("failed start (409): shows status, server message, hint and body; does not refresh or create", async () => {
    await createReady();
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: { code: "CONFLICT", message: "That action is not allowed in the session's current state." } }));
    await tap("Start Session");
    expect(text()).toContain("Request failed (HTTP 409 CONFLICT)");
    expect(text()).toContain("That action is not allowed in the session's current state.");
    expect(text()).toContain("Start only works while the session is READY");
    expect(text()).toContain("HTTP status409");
    expect(text()).toContain('"code": "CONFLICT"');
    expect(text()).not.toContain("Step 2 of 2");
    expect(calls("GET", DETAILS)).toBe(0);
    expect(calls("POST", CREATE)).toBe(1);
    expect(button("Start Session").disabled).toBe(false); // last reported status is still READY; Refresh shows the truth
  });

  it("failed start (network error or 401) is never shown as started and triggers no refresh", async () => {
    await createReady();
    fetchMock.mockRejectedValueOnce(new TypeError("Load failed"));
    await tap("Start Session");
    expect(text()).toContain("Request did not reach the server");
    fetchMock.mockResolvedValueOnce(json(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "You need to log in." } }));
    await tap("Start Session");
    expect(text()).toContain("Request failed (HTTP 401 UNAUTHENTICATED)");
    expect(text()).not.toContain("Session started");
    expect(calls("GET", DETAILS)).toBe(0);
  });

  it("start succeeded but the refresh failed: both responses are shown, status comes from the start response", async () => {
    await createReady();
    fetchMock.mockResolvedValueOnce(startedJson())
      .mockResolvedValueOnce(json(500, { ok: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }));
    await tap("Start Session");
    expect(text()).toContain("Session started (HTTP 200)");
    expect(text()).toContain("Step 2 of 2: Refresh");
    expect(text()).toContain("Request failed (HTTP 500 INTERNAL_ERROR)");
    expect(text()).toContain("Status (last reported)IN_PROGRESS");
    expect(button("Start Session").disabled).toBe(true);
  });

  // Every non-READY status allowed by migration 0004.
  it.each(["WAITING", "IN_PROGRESS", "SUBMITTED", "COMPLETED", "CANCELLED", "ABANDONED"])("is disabled when the session is %s", async (status) => {
    await createReady();
    fetchMock.mockResolvedValueOnce(sessionJson(status));
    await tap("Refresh session");
    expect(button("Start Session").disabled).toBe(true);
    expect(text()).toContain(`this session is ${status}`);
    await act(async () => { button("Start Session").click(); }); // disabled: no request
    expect(calls("POST", START)).toBe(0);
  });

  it("is disabled after a create that does not report READY", async () => {
    fetchMock.mockResolvedValueOnce(created("WAITING"));
    await tap("Create Practice Session");
    expect(button("Start Session").disabled).toBe(true);
  });

  it("becomes enabled again only when a session is reported READY (e.g. a newly created one)", async () => {
    await createReady();
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { session: { sessionId: SESSION, status: "CANCELLED" } } }));
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await tap("Cancel session");
    expect(button("Start Session").disabled).toBe(true);
    await createReady();
    expect(button("Start Session").disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// v1.2.4: result submission, completion check, rejection tests, own-session cleanup.
// ---------------------------------------------------------------------------------------

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
function view(status: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      session: {
        sessionId: SESSION, configId: "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac", gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE",
        status, validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED", startedAt: null, deadlineAt: null, completedAt: null,
        result: null, ...extra,
      },
    },
  };
}
const running = () => view("IN_PROGRESS", { startedAt: inSeconds(-5), deadlineAt: inSeconds(205) });
const completedView = (score: number) => view("COMPLETED", {
  validationStatus: "UNVERIFIED", startedAt: inSeconds(-60), deadlineAt: inSeconds(150), completedAt: inSeconds(0),
  result: { format: "SCORE_ATTACK", score },
});
const RESULT_URL = `/api/competitions/sessions/${SESSION}/result`;
const DETAILS_URL = `/api/competitions/sessions/${SESSION}`;
const requests = () => fetchMock.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u)}`);

async function rerender(sessions: MySessions) {
  await act(async () => {
    root.render(createElement(TestPanel, { email: "tester@example.com", config: CONFIG, registryReady: true, sessions }));
  });
}
async function typeScore(value: string) {
  const input = container.querySelector<HTMLInputElement>("input[inputmode=numeric]");
  if (!input) throw new Error("score input missing");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Create (READY) then Start (IN_PROGRESS) through the UI with fake responses. */
async function toInProgress() {
  fetchMock.mockResolvedValueOnce(created("READY"));
  await tap("Create Practice Session");
  fetchMock.mockResolvedValueOnce(json(200, running())).mockResolvedValueOnce(json(200, running()));
  await tap("Start Session");
}

describe("Submit Result", () => {
  it("is disabled until the session is IN_PROGRESS and a valid score is entered", async () => {
    expect(button("Submit Result").disabled).toBe(true);
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
    await typeScore("4200");
    expect(button("Submit Result").disabled).toBe(true);
    expect(text()).toContain("Start the session first");
    fetchMock.mockResolvedValueOnce(json(200, running())).mockResolvedValueOnce(json(200, running()));
    await tap("Start Session");
    expect(button("Submit Result").disabled).toBe(false);
    for (const bad of ["-1", "1.5", "abc", "1000000000001"]) {
      await typeScore(bad);
      expect(button("Submit Result").disabled, bad).toBe(true);
    }
    expect(text()).toContain("from 0 to 1,000,000,000,000");
  });

  it("asks for confirmation; declining sends nothing", async () => {
    await toInProgress();
    await typeScore("4200");
    const before = fetchMock.mock.calls.length;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await tap("Submit Result");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Submit score 4200"));
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("accepted: sends the exact body, reloads, and confirms completion from the reloaded session", async () => {
    await toInProgress();
    await typeScore("4200");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const submitD = deferred();
    fetchMock.mockReturnValueOnce(submitD.promise).mockResolvedValueOnce(json(200, completedView(4200)));
    await tap("Submit Result");
    expect(button("Submitting…").disabled).toBe(true);
    expect(text()).toContain("Submitting result…");
    await act(async () => { button("Submitting…").click(); button("Submitting…").click(); });
    expect(requests().filter((r) => r === `POST ${RESULT_URL}`)).toHaveLength(1);

    await act(async () => { submitD.resolve(json(200, completedView(4200))); });
    const [, init] = fetchMock.mock.calls.find(([u]) => u === RESULT_URL) ?? [];
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ format: "SCORE_ATTACK", score: 4200 }) });
    expect(text()).toContain("Result accepted by the API (HTTP 200)");
    expect(text()).toContain("Step 2 of 2: Refresh");
    expect(text()).toContain("PASS: Session completion (from the reloaded session)");
    expect(text()).toContain("✓ Stored score is 4200");
    expect(text()).toContain("✓ Settlement NOT_REQUIRED (no payout for practice)");
    expect(text()).toContain("Status (last reported)COMPLETED");
    expect(text()).toContain("Stored result4200");
    expect(button("Submit Result").disabled).toBe(true); // completed: no second submission from the normal control
    expect(router.refresh).toHaveBeenCalled();
    expect(requests().filter((r) => r === "POST /api/competitions/sessions")).toHaveLength(1);
  });

  it("accepted but the reloaded session is not completed: FAIL is shown, never success", async () => {
    await toInProgress();
    await typeScore("10");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(json(200, completedView(10))).mockResolvedValueOnce(json(200, running()));
    await tap("Submit Result");
    expect(text()).toContain("FAIL: Session completion");
    expect(text()).toContain("✗ Status is IN_PROGRESS, not COMPLETED");
  });

  it("refused (409 duplicate / 409 deadline): shows the real error, does not reload or claim completion", async () => {
    await toInProgress();
    await typeScore("10");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: { code: "CONFLICT", message: "The time limit for this session has passed." } }));
    await tap("Submit Result");
    expect(text()).toContain("Request failed (HTTP 409 CONFLICT)");
    expect(text()).toContain("marked the session ABANDONED and did NOT store the result");
    expect(text()).not.toContain("Session completion");
    expect(requests().filter((r) => r === `GET ${DETAILS_URL}`)).toHaveLength(1); // only the one after Start
  });

  it("is not offered once the deadline has passed by the device clock", async () => {
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
    fetchMock.mockResolvedValueOnce(json(200, view("IN_PROGRESS", { startedAt: inSeconds(-400), deadlineAt: inSeconds(-190) })));
    await tap("Refresh session");
    await typeScore("10");
    expect(button("Submit Result").disabled).toBe(true);
    expect(text()).toContain("The deadline has passed");
    expect(text()).toMatch(/Deadline passed 3:1\d ago/);
  });
});

describe("Rejected-operation tests", () => {
  const runTest = (label: string) => act(async () => {
    const b = container.querySelector<HTMLButtonElement>(`button[aria-label="Run test: ${label}"]`);
    if (!b) throw new Error(`no test button ${label}`);
    b.click();
  });
  const testButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Run test: ${label}"]`);

  it("duplicate result: reloads, sends, reloads, and reports PASS when refused and unchanged", async () => {
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
    // One fixture for every read: completedView() stamps times from Date.now(), and the panel
    // (correctly) treats a different completedAt as a change.
    const done = completedView(5);
    fetchMock.mockResolvedValueOnce(json(200, done));
    await tap("Refresh session");
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json(200, done))
      .mockResolvedValueOnce(json(409, { ok: false, error: { code: "CONFLICT", message: "That action is not allowed in the session's current state." } }))
      .mockResolvedValueOnce(json(200, done));
    await runTest("Submit again / to a finished session");
    expect(requests()).toEqual([`GET ${DETAILS_URL}`, `POST ${RESULT_URL}`, `GET ${DETAILS_URL}`]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ format: "SCORE_ATTACK", score: 1 }));
    expect(text()).toContain("PASS: Submit again / to a finished session");
    expect(text()).toContain("Session unchanged (status COMPLETED, result 5)");
    expect(text()).toContain("Step 2 of 3: Test request: Submit result");
  });

  it("does not send the test request when the fresh pre-check no longer predicts a refusal", async () => {
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
    fetchMock.mockResolvedValueOnce(json(200, view("CANCELLED", { completedAt: inSeconds(0) })));
    await tap("Refresh session");
    expect(testButton("Cancel a finished session (repeat cancellation)")?.disabled).toBe(false);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(200, view("READY"))); // someone/something changed it: now cancellable
    await runTest("Cancel a finished session (repeat cancellation)");
    expect(requests()).toEqual([`GET ${DETAILS_URL}`]);
    expect(text()).toContain("INCONCLUSIVE: Cancel a finished session");
    expect(text()).toContain("Not sent.");
  });

  it("a test that would succeed is not offered (e.g. start on READY, cancel on READY)", async () => {
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
    expect(testButton("Start a session that is not READY")?.disabled).toBe(true);
    expect(testButton("Cancel a finished session (repeat cancellation)")?.disabled).toBe(true);
    expect(testButton("Submit a result before starting")?.disabled).toBe(false);
  });

  it("unknown session: one GET to the fixed unknown id; 404 is a PASS; no session state is touched", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { ok: false, error: { code: "NOT_FOUND", message: "Session not found." } }));
    await runTest("Read a session that is not yours");
    expect(requests()).toEqual(["GET /api/competitions/sessions/00000000-0000-4000-8000-000000000000"]);
    expect(text()).toContain("PASS: Read a session that is not yours");
    expect(text()).toContain("Session IDnone yet");
  });

  it("late submission: PASS when refused with the time-limit message and the session becomes ABANDONED", async () => {
    fetchMock.mockResolvedValueOnce(created("READY"));
    await tap("Create Practice Session");
    const late = view("IN_PROGRESS", { startedAt: inSeconds(-400), deadlineAt: inSeconds(-190) });
    fetchMock.mockResolvedValueOnce(json(200, late));
    await tap("Refresh session");
    fetchMock
      .mockResolvedValueOnce(json(200, late))
      .mockResolvedValueOnce(json(409, { ok: false, error: { code: "CONFLICT", message: "The time limit for this session has passed." } }))
      .mockResolvedValueOnce(json(200, view("ABANDONED", { startedAt: late.data.session.startedAt, deadlineAt: late.data.session.deadlineAt, completedAt: inSeconds(0) })));
    await runTest("Submit after the deadline");
    expect(text()).toContain("PASS: Submit after the deadline");
    expect(text()).toContain("Backend marked the session ABANDONED and stored no result");
  });
});

describe("Your sessions (cleanup)", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const FINISHED = "33333333-3333-4333-8333-333333333333";
  const LIST: MySessions = {
    state: "ok", openCount: 1, maxOpen: 3, shownLimit: 50, loadedAt: "2026-10-11T12:00:00Z",
    rows: [
      { sessionId: SESSION, isTestConfig: true, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY", validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED", createdAt: "2026-10-11T11:00:00Z", startedAt: null, deadlineAt: null, completedAt: null, countsTowardLimit: true, deadlinePassed: false, cancelOutcome: "CANCELLED" },
      { sessionId: OTHER, isTestConfig: true, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status: "IN_PROGRESS", validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED", createdAt: "2026-10-11T10:00:00Z", startedAt: "2026-10-11T10:00:05Z", deadlineAt: "2026-10-11T10:03:35Z", completedAt: null, countsTowardLimit: false, deadlinePassed: true, cancelOutcome: "ABANDONED" },
      { sessionId: FINISHED, isTestConfig: true, gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status: "COMPLETED", validationStatus: "UNVERIFIED", settlementStatus: "NOT_REQUIRED", createdAt: "2026-10-11T09:00:00Z", startedAt: "2026-10-11T09:00:05Z", deadlineAt: "2026-10-11T09:03:35Z", completedAt: "2026-10-11T09:01:00Z", countsTowardLimit: false, deadlinePassed: true, cancelOutcome: null },
    ],
  };
  const rowButton = (label: string) => {
    const b = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!b) throw new Error(label);
    return b;
  };

  it("lists id, status, limit and the real cancel outcome; sends nothing on load", async () => {
    await rerender(LIST);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text()).toContain("Open sessions counting toward the limit1 / 3");
    for (const id of [SESSION, OTHER, FINISHED]) expect(text()).toContain(id);
    expect(text()).toContain("IN_PROGRESS · deadline passed");
    expect(rowButton("Cancel session 11111111").textContent).toBe("Cancel (→ CANCELLED)");
    expect(rowButton("Cancel session 22222222").textContent).toBe("Cancel (→ ABANDONED)");
    expect(rowButton("Cancel session 33333333").disabled).toBe(true);
    expect(text()).toContain("Finished: cannot be cancelled.");
  });

  it("cancel requires confirmation naming the outcome; then cancels that session, reloads it and the list", async () => {
    await rerender(LIST);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await act(async () => { rowButton("Cancel session 22222222").click(); });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("It will become ABANDONED (IN_PROGRESS → ABANDONED)"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Nothing is deleted"));
    expect(fetchMock).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    const abandoned = { ok: true, data: { session: { sessionId: OTHER, status: "ABANDONED", completedAt: "2026-10-11T12:01:00Z" } } };
    fetchMock.mockResolvedValueOnce(json(200, abandoned)).mockResolvedValueOnce(json(200, abandoned));
    await act(async () => { rowButton("Cancel session 22222222").click(); });
    expect(requests()).toEqual([`POST /api/competitions/sessions/${OTHER}/cancel`, `GET /api/competitions/sessions/${OTHER}`]);
    expect(router.refresh).toHaveBeenCalled();
    expect(text()).toContain("Session cancelled (HTTP 200)");
    expect(text()).toContain("Status (last reported)ABANDONED");
  });

  it("Use loads that session (GET) and makes it current; Reload list only re-renders the page", async () => {
    await rerender(LIST);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { session: { sessionId: OTHER, status: "IN_PROGRESS", deadlineAt: "2026-10-11T10:03:35Z" } } }));
    await act(async () => { rowButton("Use session 22222222").click(); });
    expect(requests()).toEqual([`GET /api/competitions/sessions/${OTHER}`]);
    expect(text()).toContain(`Session ID${OTHER}`);
    await tap("Reload list");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a load error without crashing", async () => {
    await rerender({ state: "error" });
    expect(text()).toContain("Could not load your sessions");
  });
});

