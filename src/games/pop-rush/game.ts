import { defineGame, type GameSdk, type OfficialTiming, type SubmitOutcome } from "@/game-sdk";
import { finalScore, multiplier, newGame, progressOf, radiusAt, step, tap, type GameState, type PopRushConfig } from "./rules";

/**
 * Pop Rush rendering and platform integration. Uses ONLY the public Game SDK:
 * ready() once loaded -> waits for the platform's "start" -> plays against the official clock
 * -> submitResult() when time is up -> shows the platform-confirmed outcome.
 */

type Screen = "waiting" | "playing" | "paused" | "saving" | "result" | "ended";
type Effect = { x: number; y: number; t: number; text: string; color: string };

const COLORS = { bg: "#0f1115", normal: "#4ade80", gold: "#fbbf24", bomb: "#f87171", text: "#f4f4f5", muted: "#a1a1aa" };
const HUD_HEIGHT = 64;

function readConfig(sdk: GameSdk): PopRushConfig {
  const c = sdk.context.gameConfig;
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && v >= min && v <= max ? v : d);
  return { maxBubbles: num(c.maxBubbles, 7, 1, 12), bombsAfterSeconds: num(c.bombsAfterSeconds, 20, 0, 180) };
}

function formatTime(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default defineGame({
  mount(root: HTMLElement, sdk: GameSdk) {
    const cfg = readConfig(sdk);
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "Pop Rush game area");
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none";
    root.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      sdk.reportError("NO_CANVAS", "Canvas 2D is not available on this device.", { fatal: true });
      return { dispose: () => canvas.remove() };
    }

    let screen: Screen = "waiting";
    let timing: OfficialTiming = sdk.timing();
    let state: GameState = newGame();
    let effects: Effect[] = [];
    let outcome: SubmitOutcome | null = null;
    let endNote = "";
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;

    // ---- layout: follow the container (rotation, browser bars, split screen) ----
    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);

    // ---- input: pointer events cover touch, pen and mouse ----
    const onPointer = (e: PointerEvent) => {
      e.preventDefault();
      if (screen !== "playing") return;
      const rect = canvas.getBoundingClientRect();
      const r = tap(state, e.clientX - rect.left, e.clientY - rect.top);
      if (r.kind === "miss") effects.push({ x: r.x, y: r.y, t: state.t, text: "miss", color: COLORS.muted });
      else effects.push({ x: r.x, y: r.y, t: state.t, text: r.points > 0 ? `+${r.points}` : `${r.points}`, color: COLORS[r.kind] });
    };
    canvas.addEventListener("pointerdown", onPointer);

    // ---- loop ----
    const loop = (now: number) => {
      frame = 0;
      if (screen !== "playing") return;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
      last = now;
      const remaining = timing.remainingMs() ?? 0;
      if (remaining <= 0) {
        endRound();
        return;
      }
      const elapsedMs = timing.timeLimitSeconds * 1000 - remaining;
      step(state, dt, { progress: progressOf(elapsedMs, timing.timeLimitSeconds), elapsedSeconds: elapsedMs / 1000 },
        { width, top: HUD_HEIGHT, height: height - HUD_HEIGHT }, cfg, Math.random);
      effects = effects.filter((f) => state.t - f.t < 0.7);
      draw();
      frame = requestAnimationFrame(loop);
    };
    const run = () => {
      last = 0;
      if (!frame) frame = requestAnimationFrame(loop);
    };
    const halt = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    function endRound() {
      if (screen === "saving" || screen === "result") return;
      halt();
      screen = "saving";
      state.bubbles = [];
      draw();
      sdk.submitResult({ score: finalScore(state) }).then(showOutcome, (err: unknown) => {
        screen = "ended";
        endNote = err instanceof Error ? err.message : "The result could not be submitted.";
        draw();
      });
    }

    function showOutcome(o: SubmitOutcome) {
      outcome = o;
      screen = "result";
      draw();
    }

    // ---- platform events ----
    const offs = [
      sdk.on("start", (t) => {
        timing = t;
        state = newGame();
        screen = "playing";
        run();
      }),
      sdk.on("pause", () => {
        if (screen !== "playing") return;
        screen = "paused";
        halt();
        draw();
      }),
      sdk.on("resume", (t) => {
        if (screen !== "paused") return;
        timing = t;
        screen = "playing";
        run(); // the official clock kept running; if time is up the loop ends the round at once
      }),
      sdk.on("result", showOutcome), // later final answer after an unresolved one
      sdk.on("terminate", (info) => {
        halt();
        if (screen === "result") return;
        screen = "ended";
        endNote = info.message;
        draw();
      }),
    ];

    // ---- drawing ----
    function centerText(text: string, y: number, size: number, color: string, weight = 700) {
      if (!ctx) return;
      ctx.fillStyle = color;
      ctx.font = `${weight} ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, width / 2, y, width - 32);
    }

    function draw() {
      if (!ctx) return;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, width, height);
      const mid = height / 2;

      if (screen === "waiting") {
        centerText("Pop Rush", mid - 70, 40, COLORS.normal, 800);
        centerText("Tap bubbles before they vanish.", mid - 20, 17, COLORS.text, 500);
        centerText("Gold = bonus · Red bombs = penalty", mid + 8, 15, COLORS.muted, 500);
        centerText("Chain hits for up to x5 points.", mid + 34, 15, COLORS.muted, 500);
        return;
      }

      // Bubbles
      for (const b of state.bubbles) {
        const r = radiusAt(b, state.t);
        if (r <= 0) continue;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fillStyle = COLORS[b.kind];
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (b.kind === "bomb") centerTextAt("✕", b.x, b.y, r);
      }
      // Pop feedback
      for (const f of effects) {
        const age = state.t - f.t;
        ctx.globalAlpha = Math.max(0, 1 - age / 0.7);
        ctx.fillStyle = f.color;
        ctx.font = "800 18px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(f.text, f.x, f.y - age * 40);
        ctx.globalAlpha = 1;
      }

      // HUD
      const remaining = timing.remainingMs();
      ctx.fillStyle = "rgba(15,17,21,.85)";
      ctx.fillRect(0, 0, width, HUD_HEIGHT);
      ctx.textBaseline = "middle";
      ctx.font = "800 22px system-ui, sans-serif";
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "left";
      ctx.fillText(String(finalScore(state)), 16, HUD_HEIGHT / 2);
      ctx.textAlign = "center";
      ctx.fillStyle = remaining !== null && remaining < 10_000 ? COLORS.bomb : COLORS.text;
      ctx.fillText(remaining === null ? "3:00" : formatTime(remaining), width / 2, HUD_HEIGHT / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = COLORS.gold;
      ctx.fillText(`x${multiplier(state.combo)}`, width - 16, HUD_HEIGHT / 2);

      if (screen === "paused") overlay("Paused", "The timer keeps running on the server.");
      if (screen === "saving") overlay(`Score ${finalScore(state)}`, "Time! Saving your result…");
      if (screen === "ended") overlay(`Score ${finalScore(state)}`, endNote || "This game has ended.");
      if (screen === "result" && outcome) {
        if (outcome.status === "completed") {
          overlay(`Score ${outcome.score}`, `Saved. Practice result (${outcome.validation.toLowerCase()}); no rewards for practice.`);
        } else if (outcome.status === "pending_verification") {
          overlay(`Score ${outcome.score}`, "Submitted. Waiting for verification.");
        } else {
          overlay(`Score ${finalScore(state)}`, outcome.message);
        }
      }
    }

    function centerTextAt(text: string, x: number, y: number, r: number) {
      if (!ctx) return;
      ctx.fillStyle = COLORS.bg;
      ctx.font = `800 ${Math.max(10, r)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
    }

    function overlay(title: string, line: string) {
      if (!ctx) return;
      ctx.fillStyle = "rgba(15,17,21,.78)";
      ctx.fillRect(0, HUD_HEIGHT, width, height - HUD_HEIGHT);
      centerText(title, height / 2 - 24, 34, COLORS.text, 800);
      centerText(line, height / 2 + 16, 15, COLORS.muted, 500);
    }

    resize();
    sdk.ready();

    return {
      dispose() {
        halt();
        observer.disconnect();
        canvas.removeEventListener("pointerdown", onPointer);
        for (const off of offs) off();
        canvas.remove();
      },
    };
  },
});
