import { afterEach, describe, expect, it, vi } from "vitest";

// UNIT: the REAL next.config.ts headers() (static config). Browser enforcement of these headers
// is verified separately in real Chromium (see BUILD_LOG v1.3.1); this guards against regressions.

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

async function rules(nodeEnv: string): Promise<Rule[]> {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  const config = (await import("../../next.config")).default;
  if (!config.headers) throw new Error("no headers()");
  return (await config.headers()) as Rule[];
}
const header = (rule: Rule | undefined, key: string) => rule?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
const directives = (csp: string | undefined) => (csp ?? "").split(";").map((d) => d.trim()).filter(Boolean);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("game frame response headers (F1)", () => {
  for (const env of ["production", "development"]) {
    it(`sandboxes the game frame document itself via CSP (${env})`, async () => {
      const frame = (await rules(env)).find((r) => r.source === "/game-frame/:path*");
      const csp = directives(header(frame, "Content-Security-Policy"));
      // Exactly allow-scripts: never same-origin (that would restore the platform origin), and no
      // popups, forms, top navigation, modals, downloads or other escapes.
      expect(csp.filter((d) => d.startsWith("sandbox"))).toEqual(["sandbox allow-scripts"]);
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("default-src 'none'");
      if (env === "production") expect(csp).toContain("connect-src 'none'");
    });
  }
});

describe("framing protection for platform routes (F3)", () => {
  /** Mirrors Next's matching of a `/:path(<regex>)` source for these paths. */
  function matches(source: string, path: string): boolean {
    const m = /^\/:path\((.*)\)$/.exec(source);
    if (!m) throw new Error(`unexpected source ${source}`);
    return new RegExp(`^/${m[1]}$`).test(path);
  }

  it("applies frame-ancestors 'self' and X-Frame-Options to every route except the game frame", async () => {
    const all = await rules("production");
    const app = all.find((r) => header(r, "X-Frame-Options"));
    expect(app).toBeDefined();
    expect(header(app, "X-Frame-Options")).toBe("SAMEORIGIN");
    expect(header(app, "Content-Security-Policy")).toBe("frame-ancestors 'self'");
    for (const p of ["/", "/login", "/games", "/games/pop-rush/play", "/wallet", "/test-panel", "/api/health", "/game-frames", "/x/game-frame/y"]) {
      expect(matches(app!.source, p), p).toBe(true);
    }
    for (const p of ["/game-frame", "/game-frame/pop-rush", "/game-frame/sum-sprint"]) {
      expect(matches(app!.source, p), p).toBe(false);
    }
  });
});
