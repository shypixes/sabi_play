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

const { default: TestPanelPage } = await import("@/app/(app)/test-panel/page");
const { isTestPanelEnabled } = await import("@/app/(app)/test-panel/load-config");

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
    // Only one read: the config row, by id.
    expect(state.fake.queries.map((q) => q.table)).toEqual(["competition_configs"]);
    expect(state.fake.queries[0]?.ops).toContainEqual(["eq", ["id", CONFIG_ID]]);
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
