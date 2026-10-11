import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClient, createFakeState, type FakeState } from "./fake-supabase";

// MOCKED INTEGRATION: the real TEMPORARY test panel page (server component + client component
// rendered to HTML) with a fake Supabase client. Proves gating, config display and that nothing
// is requested on load. Not a browser test. Remove together with src/app/(app)/test-panel.

const state: { fake: FakeState } = { fake: createFakeState() };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => createFakeClient(state.fake) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// Only useRouter is replaced (it needs the App Router at runtime); notFound/redirect stay real.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { default: TestPanelPage } = await import("@/app/(app)/test-panel/page");
const { isTestPanelEnabled } = await import("@/app/(app)/test-panel/load-config");
const { loadMySessions, MY_SESSIONS_LIMIT } = await import("@/app/(app)/test-panel/load-sessions");

const CONFIG_ID = "e3955f36-6ca7-47d2-8c1e-9b95da7b57ac";
const configRow = (o: Record<string, unknown> = {}) => ({
  id: CONFIG_ID, game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", label: "Test practice",
  entry_fee: 0, reward_model: null, fixed_reward: null, target_score: null, platform_fee_bps: null,
  pool_size: null, payout_bps: null, time_limit_seconds: 180, enabled: true, ...o,
});

async function renderPage(): Promise<string> {
  return renderToString(await TestPanelPage());
}
async function thrownBy(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return String((e as { digest?: string }).digest ?? e); }
  return "did not throw";
}

const fetchSpy = vi.fn();
beforeEach(() => {
  state.fake = createFakeState();
  state.fake.user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "tester@example.com" } as FakeState["user"];
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sr-secret-should-never-render");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchSpy.mockReset();
});

describe("access", () => {
  it("is enabled in preview and local dev, disabled in Vercel production", () => {
    expect(isTestPanelEnabled({ VERCEL_ENV: "preview" })).toBe(true);
    expect(isTestPanelEnabled({ VERCEL_ENV: "development" })).toBe(true);
    expect(isTestPanelEnabled({})).toBe(true);
    expect(isTestPanelEnabled({ VERCEL_ENV: "production" })).toBe(false);
  });

  it("returns 404 in production before touching auth or the database", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await thrownBy(TestPanelPage())).toMatch(/404|NOT_FOUND/);
    expect(state.fake.queries).toEqual([]);
  });

  it("redirects signed-out visitors to /login and loads nothing", async () => {
    state.fake.user = null;
    expect(await thrownBy(TestPanelPage())).toMatch(/NEXT_REDIRECT.*\/login/);
    expect(state.fake.queries).toEqual([]);
  });
});

describe("rendering for a signed-in user", () => {
  it("shows auth status, the config, the warning and the button, and sends no request on load", async () => {
    state.fake.tables.competition_configs = { data: configRow(), error: null };
    const html = await renderPage();
    for (const text of [
      "Competition Test Panel", "Temporary test tool", "Signed in", "tester@example.com", CONFIG_ID,
      "test-game", "SCORE_ATTACK", "PRACTICE", "0 PlayCoins", "180s", "Create Practice Session",
      "real session in the database", "test-game · Score Attack available", "No request sent yet.",
    ]) expect(html, text).toContain(text);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.fake.rpcCalls).toEqual([]);
    // Two reads only: the config row by id, and the caller's own sessions. No writes.
    expect(state.fake.queries.map((q) => q.table).sort()).toEqual(["competition_configs", "competition_sessions"]);
    expect(state.fake.queries.find((q) => q.table === "competition_configs")?.ops).toContainEqual(["eq", ["id", CONFIG_ID]]);
  });

  it("result actions start disabled (nothing to refresh, cancel or clear yet)", async () => {
    state.fake.tables.competition_configs = { data: configRow(), error: null };
    const html = await renderPage();
    for (const label of ["Refresh session", "Cancel session", "Clear result"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
    }
    expect(html).toMatch(/<button[^>]*>Create Practice Session<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Create Practice Session/);
  });

  it("warns when the config is disabled", async () => {
    state.fake.tables.competition_configs = { data: configRow({ enabled: false }), error: null };
    expect(await renderPage()).toContain("No (creation will fail with 409)");
  });

  it("explains a missing config, an invalid row and a load error without crashing", async () => {
    state.fake.tables.competition_configs = { data: null, error: null };
    expect(await renderPage()).toContain("Not found in the Supabase project");
    state.fake.tables.competition_configs = { data: configRow({ entry_fee: 5 }), error: null }; // practice with fee: invalid
    expect(await renderPage()).toContain("did not pass validation");
    state.fake.tables.competition_configs = { data: null, error: { code: "42501", message: "permission denied" } };
    const html = await renderPage();
    expect(html).toContain("Could not load the configuration");
    expect(html).not.toContain("permission denied");
  });

  it("never renders secrets or server-only values", async () => {
    state.fake.tables.competition_configs = { data: configRow(), error: null };
    const html = await renderPage();
    expect(html).not.toContain("sr-secret-should-never-render");
    expect(html).not.toMatch(/service[_-]?role|access_token|refresh_token/i);
  });
});

describe("your sessions (server-side, RLS-scoped read)", () => {
  const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const NOW = Date.parse("2026-10-11T12:00:00Z");
  const row = (id: string, status: string, o: Record<string, unknown> = {}) => ({
    id, config_id: CONFIG_ID, game_id: "test-game", format: "SCORE_ATTACK", mode: "PRACTICE", status,
    validation_status: "NOT_SUBMITTED", settlement_status: "NOT_REQUIRED", created_at: "2026-10-11T11:00:00Z",
    started_at: null, deadline_at: null, completed_at: null, ...o,
  });
  const rows = [
    row("11111111-1111-4111-8111-111111111111", "READY"),
    row("22222222-2222-4222-8222-222222222222", "IN_PROGRESS", { started_at: "2026-10-11T11:58:00Z", deadline_at: "2026-10-11T12:01:30Z" }),
    row("33333333-3333-4333-8333-333333333333", "IN_PROGRESS", { started_at: "2026-10-11T11:00:00Z", deadline_at: "2026-10-11T11:03:30Z" }),
    row("44444444-4444-4444-8444-444444444444", "COMPLETED", { validation_status: "UNVERIFIED", completed_at: "2026-10-11T11:02:00Z" }),
    row("55555555-5555-4555-8555-555555555555", "CANCELLED", { completed_at: "2026-10-11T11:02:00Z" }),
  ];

  it("reads only the caller's own sessions (created_by = caller, newest first, limited)", async () => {
    state.fake.tables.competition_sessions = { data: rows, error: null };
    await loadMySessions(ME, NOW);
    const q = state.fake.queries.find((x) => x.table === "competition_sessions");
    expect(q?.ops).toContainEqual(["eq", ["created_by", ME]]);
    expect(q?.ops).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(q?.ops).toContainEqual(["limit", [MY_SESSIONS_LIMIT]]);
    expect(state.fake.rpcCalls).toEqual([]);
  });

  it("computes limit counting and cancel outcomes exactly like the database functions", async () => {
    state.fake.tables.competition_sessions = { data: rows, error: null };
    const r = await loadMySessions(ME, NOW);
    if (r.state !== "ok") throw new Error("expected ok");
    expect(r.rows.map((x) => [x.status, x.countsTowardLimit, x.deadlinePassed, x.cancelOutcome])).toEqual([
      ["READY", true, false, "CANCELLED"],
      ["IN_PROGRESS", true, false, "ABANDONED"],
      ["IN_PROGRESS", false, true, "ABANDONED"], // past deadline: still IN_PROGRESS, no longer counted
      ["COMPLETED", false, false, null],
      ["CANCELLED", false, false, null],
    ]);
    expect(r.openCount).toBe(2);
    expect(r.maxOpen).toBe(3);
  });

  it("skips malformed rows and reports a load error without exposing it", async () => {
    state.fake.tables.competition_sessions = { data: [rows[0], { id: "nope" }], error: null };
    const r = await loadMySessions(ME, NOW);
    expect(r.state === "ok" && r.rows.length).toBe(1);
    state.fake.tables.competition_sessions = { data: null, error: { code: "42501", message: "permission denied" } };
    expect(await loadMySessions(ME, NOW)).toEqual({ state: "error" });
  });

  it("the page renders the list and still sends no request on load", async () => {
    state.fake.tables.competition_configs = { data: configRow(), error: null };
    state.fake.tables.competition_sessions = { data: rows, error: null };
    const html = await renderPage();
    expect(html).toContain("Your sessions");
    expect(html).toContain("22222222-2222-4222-8222-222222222222");
    expect(html).toContain("Rejected-operation tests");
    expect(html).toContain("Submit Result");
    // Scoped to the signed-in user from the verified session, never to a client-supplied id.
    expect(state.fake.queries.find((q) => q.table === "competition_sessions")?.ops).toContainEqual(["eq", ["created_by", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.fake.rpcCalls).toEqual([]);
  });
});

