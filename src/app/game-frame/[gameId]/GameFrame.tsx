"use client";

import { useEffect, useRef, useState } from "react";
import { SdkError, connectToPlatform, type GameManifest } from "@/game-sdk";
import { GAME_LOADERS } from "@/games/loaders";
import { bootGame, windowLoaded, type BootedGame } from "./boot";
import styles from "./game-frame.module.css";

/** One boot per document: a game session is a single attempt (also under React StrictMode). */
let booted = false;

/**
 * Platform-owned bootstrap inside the sandboxed frame (see boot.ts for the order): waits for the
 * document to load, connects the SDK (embedding, manifest and compatibility checks), and only
 * then imports and mounts the game module. Disposes everything on pagehide.
 */
export function GameFrame({ manifest }: { manifest: GameManifest }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || booted) return;
    booted = true;
    const loader = GAME_LOADERS[manifest.id];
    if (!loader) {
      setError("This game is not installed on the platform.");
      return;
    }
    let game: BootedGame | null = null;
    let leaving = false;
    const teardown = () => {
      leaving = true;
      game?.dispose();
      game = null;
    };
    window.addEventListener("pagehide", teardown);

    bootGame(root, { documentLoaded: windowLoaded, connect: () => connectToPlatform({ manifest }), load: loader })
      .then((started) => {
        if (leaving) started.dispose();
        else game = started;
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
