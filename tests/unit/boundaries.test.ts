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

  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const importsOf = (file: string) =>
    [...stripComments(readFileSync(file, "utf8")).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");

  it("game code imports only the public Game SDK and its own folder", () => {
    for (const dir of readdirSync(join(ROOT, "src/games")).filter((d) => statSync(join(ROOT, "src/games", d)).isDirectory())) {
      for (const file of files(join(ROOT, "src/games", dir))) {
        for (const spec of importsOf(file)) {
          const allowed = spec === "@/game-sdk" || spec.startsWith("./");
          expect(allowed, `${file} imports ${spec}`).toBe(true);
        }
      }
    }
  });

  it("the Game SDK is engine- and framework-independent (no React, Next or platform imports)", () => {
    for (const file of files(join(ROOT, "src/game-sdk"))) {
      for (const spec of importsOf(file)) {
        expect(spec === "zod" || spec.startsWith("./"), `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("game code is loaded only by the sandboxed game frame, never by platform pages", () => {
    const users = files(join(ROOT, "src"))
      .filter((f) => !f.includes(join("src", "games") + "/"))
      .filter((f) => importsOf(f).some((s) => s === "@/games/loaders" || /^@\/games\/[^/]+\/(?!manifest$)/.test(s)));
    expect(users.map((f) => f.slice(ROOT.length + 1))).toEqual([join("src", "app", "game-frame", "[gameId]", "GameFrame.tsx")]);
  });

  it("the game frame never touches auth, Supabase or server code", () => {
    for (const file of files(join(ROOT, "src/app/game-frame"))) {
      for (const spec of importsOf(file)) {
        expect(/@\/server\/|supabase|@\/lib\/(?!game-host)/.test(spec), `${file} imports ${spec}`).toBe(false);
      }
    }
  });

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
