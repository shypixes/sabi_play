"use client";

import { useEffect, useRef, useState } from "react";
import { SdkError, connectToPlatform, type GameManifest, type GameSdk } from "@/game-sdk";
import { GAME_LOADERS } from "@/games/loaders";
import styles from "./game-frame.module.css";

/** One boot per document: a game session is a single attempt (also under React StrictMode). */
let booted = false;

/**
 * Platform-owned bootstrap inside the sandboxed frame: connects the SDK (session context and
 * compatibility checks), loads the game module and mounts it. Disposes everything on pagehide.
 */
export function GameFrame({ manifest }: { manifest: GameManifest }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || booted) return;
    booted = true;
    let sdk: GameSdk | null = null;
    let handle: { dispose(): void } | null = null;
    const loader = GAME_LOADERS[manifest.id];

    const teardown = () => {
      try { handle?.dispose(); } finally { sdk?.dispose(); }
      handle = null;
      sdk = null;
    };
    window.addEventListener("pagehide", teardown);

    if (!loader) {
      setError("This game is not installed on the platform.");
      return;
    }
    Promise.all([connectToPlatform({ manifest }), loader()])
      .then(([connected, mod]) => {
        sdk = connected;
        try {
          handle = mod.default.mount(root, connected);
        } catch (err) {
          connected.reportError("MOUNT_FAILED", err instanceof Error ? err.message : "The game failed to start.", { fatal: true });
          setError("The game failed to start.");
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof SdkError ? err.message : "The game could not be loaded.");
      });
    // No cleanup on effect re-run: StrictMode re-runs effects in development, and a second
    // connection would look like a restart. The document's pagehide disposes everything.
  }, [manifest]);

  return (
    <div className={styles.frame}>
      <div ref={rootRef} className={styles.root} />
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  );
}
