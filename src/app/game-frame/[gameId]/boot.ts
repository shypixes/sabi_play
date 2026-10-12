import type { GameModule, GameSdk } from "@/game-sdk";

export type BootDeps = {
  /** Resolves once this document has finished loading (window "load"). */
  documentLoaded: () => Promise<void>;
  /** Connects to the platform host (frame, origin, manifest and compatibility checks). */
  connect: () => Promise<GameSdk>;
  /** Imports the game module. Must not be called before `connect` has succeeded. */
  load: () => Promise<{ default: GameModule }>;
};

export type BootedGame = { dispose(): void };

/**
 * Frame bootstrap, in a fixed order:
 *  1. Wait for this document to finish loading. The host treats any LATER load of the frame as
 *     a navigation, and game code (step 3) can only run after this point, so a navigating game
 *     can never be mistaken for the frame's first load.
 *  2. Connect to the platform. This validates that the document is embedded by the platform host
 *     and that the manifest and SDK are compatible; it fails when opened directly (top level).
 *  3. Only then import the game module, so untrusted game code never runs in a document that
 *     failed those checks. Then mount it.
 * Rejects with the original error. After a successful connect, a load/mount failure is reported
 * to the host as fatal (so it releases the session) and the SDK is disposed.
 */
export async function bootGame(root: HTMLElement, deps: BootDeps): Promise<BootedGame> {
  await deps.documentLoaded();
  const sdk = await deps.connect();
  let handle: { dispose(): void };
  try {
    const mod = await deps.load();
    handle = mod.default.mount(root, sdk);
  } catch (err) {
    sdk.reportError("MOUNT_FAILED", err instanceof Error ? err.message.slice(0, 200) : "The game failed to start.", { fatal: true });
    sdk.dispose();
    throw err;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try { handle.dispose(); } finally { sdk.dispose(); }
    },
  };
}

/** Browser implementation of BootDeps.documentLoaded. */
export function windowLoaded(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}
