"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GAME_CAPABILITY_PERMISSIONS, type GameCapability, type GameOrientation, type HostMessage, type SubmitOutcome } from "@/game-sdk";
import { GameHostController, type HostPhase, type LaunchInfo } from "@/lib/game-host/controller";
import { createPlatformApi, releaseSessionOnUnload } from "@/lib/game-host/platform-api";
import styles from "./GameHost.module.css";

type Props = {
  launch: LaunchInfo;
  gameName: string;
  orientations: readonly GameOrientation[];
  capabilities: readonly GameCapability[];
};

/**
 * Iframe permissions: only declared capabilities are delegated. Everything else is already
 * denied: powerful features default to 'self', which the sandboxed (opaque-origin) frame never
 * matches, and the frame's own Permissions-Policy header denies them again (next.config.ts).
 */
function permissionsFor(capabilities: readonly GameCapability[]): string | undefined {
  const granted = capabilities.map((c) => GAME_CAPABILITY_PERMISSIONS[c]).filter((p): p is string => p !== null);
  return granted.length ? granted.join("; ") : undefined;
}

const FRAME_PHASES: ReadonlySet<HostPhase> = new Set([
  "loading", "awaiting_ready", "ready", "starting", "playing", "paused", "submitting", "completed", "rejected", "unresolved", "failed",
]);

function useOrientationMismatch(orientations: readonly GameOrientation[]): boolean {
  const [mismatch, setMismatch] = useState(false);
  useEffect(() => {
    if (orientations.length !== 1) return;
    const wanted = orientations[0];
    const mq = window.matchMedia("(orientation: landscape)");
    const coarse = window.matchMedia("(pointer: coarse)");
    const update = () => setMismatch(coarse.matches && (mq.matches ? "landscape" : "portrait") !== wanted);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [orientations]);
  return mismatch;
}

function outcomeText(outcome: SubmitOutcome): string {
  switch (outcome.status) {
    case "completed":
      return `Result saved: ${outcome.score}. Practice result (${outcome.validation}, settlement ${outcome.settlement}). No wallet effect.`;
    case "pending_verification":
      return `Result submitted: ${outcome.score}. Waiting for verification.`;
    default:
      return outcome.message;
  }
}

/**
 * Platform-side game launcher. Creates and owns the practice session through the existing
 * competition API and runs the game in a sandboxed iframe that can only talk to this
 * component through the typed protocol (see GameHostController).
 */
export function GameHost({ launch, gameName, orientations, capabilities }: Props) {
  const [controller, setController] = useState(() => new GameHostController({ api: createPlatformApi(), launch }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rotate = useOrientationMismatch(orientations);

  // Wire the frame: messages are accepted only from THIS iframe's window, with the sandbox's opaque origin.
  useEffect(() => {
    controller.attachFrame({
      // "*" is required for window posts: a sandboxed frame has an opaque origin that cannot be
      // named, so the window cannot pin WHICH document receives them. Only pre-init protocol errors
      // and init itself use the window; init transfers a private port that carries everything else,
      // so a document that replaces the game later gets nothing. Messages never contain credentials.
      post(message: HostMessage) {
        frameRef.current?.contentWindow?.postMessage(message, "*");
      },
      openChannel(init: HostMessage) {
        const target = frameRef.current?.contentWindow;
        if (!target) return null;
        const channel = new MessageChannel();
        target.postMessage(init, "*", [channel.port2]);
        return channel.port1;
      },
      isFromGame: (m) => m.origin === "null" && m.source !== null && m.source === frameRef.current?.contentWindow,
    });
    const onMessage = (e: MessageEvent) => controller.receive({ data: e.data, origin: e.origin, source: e.source });
    const onVisibility = () => (document.hidden ? controller.pause() : void controller.resume());
    const onPageHide = (e: PageTransitionEvent) => {
      const s = controller.getState();
      if (!e.persisted && s.session?.status === "READY" && s.phase !== "closed") releaseSessionOnUnload(s.session.sessionId);
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Leaving the page (in-app navigation): end an unfinished session through the normal route.
      void controller.exit().finally(() => controller.dispose());
    };
  }, [controller]);

  const playAgain = useCallback(() => {
    const next = new GameHostController({ api: createPlatformApi(), launch });
    setController(next);
    void next.createSession();
  }, [launch]);

  const { phase, session, outcome, message, frameRevoked } = state;
  // A frame that navigated away (frameRevoked) is removed: its new document is not ours.
  const showFrame = FRAME_PHASES.has(phase) && session !== null && !frameRevoked;

  // Bring the whole stage (with Start and Exit) into view when a game loads, on small phones too.
  const sessionId = showFrame ? session.sessionId : null;
  useEffect(() => {
    if (sessionId) hostRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [sessionId]);
  const finished = phase === "completed" || phase === "rejected" || phase === "unresolved" || phase === "failed";
  // When a round ends, make sure the result and its actions are visible above the bottom nav.
  useEffect(() => {
    if (finished) barRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [finished]);

  if (phase === "idle" || phase === "creating") {
    return (
      <div className={`card stack ${styles.intro}`}>
        <p className="muted">
          Free practice: a 3-minute Score Attack round. Results are recorded as unverified practice and never affect your wallet.
        </p>
        {message && <p className="error" role="alert">{message}</p>}
        <button type="button" className="btn" disabled={phase === "creating"} onClick={() => void controller.createSession()}>
          {phase === "creating" ? "Creating session…" : `Play ${gameName}`}
        </button>
      </div>
    );
  }

  if (phase === "closed") {
    return (
      <div className="card stack">
        <p className="muted">{outcome ? outcomeText(outcome) : "You left the game. Unfinished sessions are ended."}</p>
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={playAgain}>Play again</button>
          <Link className="btn btn--ghost" href="/games">Back to games</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.host} ref={hostRef}>
      <div className={styles.stage}>
        {showFrame && (
          <iframe
            key={session.sessionId}
            ref={frameRef}
            className={styles.frame}
            title={`${gameName} game`}
            src={`/game-frame/${encodeURIComponent(launch.gameId)}`}
            sandbox="allow-scripts"
            onLoad={() => controller.frameLoaded()}
            allow={permissionsFor(capabilities)}
            referrerPolicy="no-referrer"
          />
        )}
        {(phase === "loading" || phase === "awaiting_ready") && <div className={styles.overlay}><p>Loading {gameName}…</p></div>}
        {(phase === "ready" || phase === "starting") && (
          <div className={`${styles.overlay} ${styles.overlayBottom}`}>
            {message && <p className="error" role="alert">{message}</p>}
            <button type="button" className={`btn ${styles.startButton}`} disabled={phase === "starting"} onClick={() => void controller.start()}>
              {phase === "starting" ? "Starting…" : "Start"}
            </button>
            <p className={styles.hint}>The 3-minute timer starts on our server when you tap Start.</p>
          </div>
        )}
        {rotate && !finished && (
          <div className={styles.overlay} role="status">
            <p>Rotate your phone to {orientations[0]} to play. The timer keeps running.</p>
          </div>
        )}
      </div>

      <div className={styles.bar} ref={barRef} aria-live="polite">
        <span className={styles.status}>
          {phase === "submitting" ? "Saving your result…"
            : phase === "paused" ? "Paused (timer still running)"
            : finished ? (outcome ? outcomeText(outcome) : message)
            : phase === "playing" ? "Playing: practice, unverified" : null}
        </span>
        <div className={styles.actions}>
          {phase === "unresolved" && <button type="button" className="btn btn--sm" onClick={() => void controller.recheck()}>Check again</button>}
          {finished && phase !== "unresolved" && <button type="button" className="btn btn--sm" onClick={playAgain}>Play again</button>}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void controller.exit()}>
            {finished ? "Close" : "Exit"}
          </button>
        </div>
      </div>
    </div>
  );
}
