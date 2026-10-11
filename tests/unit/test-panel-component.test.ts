// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestPanel } from "@/app/(app)/test-panel/TestPanel";
import type { TestConfigSummary } from "@/app/(app)/test-panel/load-config";

// UNIT (simulated browser DOM via jsdom): the TEMPORARY test panel's tap handling with a fake
// fetch. Not a real browser or a real network. Remove together with src/app/(app)/test-panel.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "11111111-1111-4111-8111-111111111111";
const CONFIG: TestConfigSummary = {
  state: "found", label: "Test practice", gameId: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE",
  entryFee: 0, timeLimitSeconds: 180, enabled: true,
};
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
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(TestPanel, { email: "tester@example.com", config: CONFIG, registryReady: true })); });
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
