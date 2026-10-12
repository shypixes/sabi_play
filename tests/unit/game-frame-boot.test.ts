import { describe, expect, it } from "vitest";
import { SdkError, defineGame, type GameModule, type GameSdk } from "@/game-sdk";
import { bootGame } from "@/app/game-frame/[gameId]/boot";
import { flush, linkedHarness } from "../helpers/game-fakes";

// UNIT (MOCKED backend): the REAL frame bootstrap order with the REAL SDK handshake (fake windows).
// Security property (F1): untrusted game code is imported only after the frame connection has
// been validated, and only after the frame's own document load.

const root = {} as unknown as HTMLElement;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function trackingModule(events: string[], mountImpl?: () => void): { default: GameModule } {
  return {
    default: defineGame({
      mount() {
        events.push("mount");
        mountImpl?.();
        return { dispose: () => events.push("game-dispose") };
      },
    }),
  };
}

describe("game frame boot order", () => {
  it("waits for the document load, then connects, and only then imports and mounts the game", async () => {
    const h = linkedHarness();
    await h.controller.createSession();
    const events: string[] = [];
    const loaded = deferred();
    const booting = bootGame(root, {
      documentLoaded: () => { events.push("await-load"); return loaded.promise; },
      connect: () => { events.push("connect"); return h.connect(); },
      load: async () => { events.push("import"); return trackingModule(events); },
    });
    await flush();
    expect(events).toEqual(["await-load"]); // nothing else before the document has loaded

    loaded.resolve();
    const game = await booting;
    expect(events).toEqual(["await-load", "connect", "import", "mount"]);
    expect(h.controller.getState().phase).toBe("awaiting_ready");
    game.dispose();
    game.dispose(); // idempotent
    expect(events.filter((e) => e === "game-dispose")).toHaveLength(1);
  });

  it("does not import the game while the connection is pending", async () => {
    const events: string[] = [];
    const connection = deferred<GameSdk>();
    const booting = bootGame(root, {
      documentLoaded: async () => undefined,
      connect: () => { events.push("connect"); return connection.promise; },
      load: async () => { events.push("import"); return trackingModule(events); },
    });
    await flush();
    expect(events).toEqual(["connect"]);
    connection.reject(new SdkError("HOST_TIMEOUT", "no host"));
    await expect(booting).rejects.toThrow("no host");
    expect(events).toEqual(["connect"]);
  });

  it("never imports the game when opened outside the platform frame (connect fails)", async () => {
    let imported = false;
    await expect(bootGame(root, {
      documentLoaded: async () => undefined,
      connect: async () => { throw new SdkError("NOT_IN_FRAME", "The game must be launched by the Sabi Play platform."); },
      load: async () => { imported = true; return trackingModule([]); },
    })).rejects.toMatchObject({ code: "NOT_IN_FRAME" });
    expect(imported).toBe(false);
  });

  it("reports a failed import or mount to the host as fatal, so the session is released", async () => {
    for (const failure of ["import", "mount"] as const) {
      const h = linkedHarness();
      await h.controller.createSession();
      const booting = bootGame(root, {
        documentLoaded: async () => undefined,
        connect: () => h.connect(),
        load: async () => {
          if (failure === "import") throw new Error("chunk failed");
          return trackingModule([], () => { throw new Error("mount failed"); });
        },
      });
      await expect(booting).rejects.toThrow(failure === "import" ? "chunk failed" : "mount failed");
      await flush();
      const state = h.controller.getState();
      expect(state.phase).toBe("failed");
      expect(state.message).toMatch(/MOUNT_FAILED/);
      expect(h.backend.sessions.get(state.session!.sessionId)!.status).toBe("CANCELLED");
    }
  });
});
