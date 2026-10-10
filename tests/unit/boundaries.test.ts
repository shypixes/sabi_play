import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UNIT (static): games and the Game SDK must never reach wallets, the database or server code.
// This is an import-graph check, not a runtime sandbox.

const ROOT = join(__dirname, "..", "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const FORBIDDEN = [/@\/server\//, /@\/lib\/supabase/, /@supabase\//, /wallet/i, /createAdminClient/, /SERVICE_ROLE/];

describe("module boundaries", () => {
  for (const dir of ["src/game-sdk", "src/games"]) {
    it(`${dir} does not import server, Supabase or wallet code`, () => {
      for (const file of files(join(ROOT, dir))) {
        const imports = [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
        for (const spec of imports) {
          for (const re of FORBIDDEN) expect(re.test(spec), `${file} imports ${spec}`).toBe(false);
        }
      }
    });
  }

  it("the Game SDK platform API exposes no wallet or settlement operations", () => {
    const src = readFileSync(join(ROOT, "src/game-sdk/competition.ts"), "utf8");
    const api = src.slice(src.indexOf("export interface GamePlatformApi"));
    expect(api).not.toMatch(/wallet|balance|settle|payout|credit|debit/i);
  });

  it("the service-role client is only used by the trusted validator module", () => {
    const users = files(join(ROOT, "src"))
      .filter((f) => !f.endsWith(join("lib", "supabase", "admin.ts")))
      .filter((f) => readFileSync(f, "utf8").includes("createAdminClient"));
    expect(users.map((f) => f.slice(ROOT.length + 1))).toEqual([join("src", "server", "competition-validation.ts")]);
  });
});
