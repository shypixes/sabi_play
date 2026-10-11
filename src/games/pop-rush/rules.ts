/**
 * Pop Rush gameplay rules (pure, deterministic given a random source). Kept separate from
 * rendering so they can be unit tested and tuned without touching the canvas code.
 */

export type BubbleKind = "normal" | "gold" | "bomb";

export type Bubble = {
  id: number;
  kind: BubbleKind;
  x: number;
  y: number;
  /** Full radius in CSS pixels. */
  r: number;
  /** Game time (seconds) when it appeared and its total lifetime. */
  born: number;
  life: number;
};

export type PopRushConfig = { maxBubbles: number; bombsAfterSeconds: number };

export type GameState = {
  score: number;
  combo: number;
  bestCombo: number;
  hits: number;
  misses: number;
  bubbles: Bubble[];
  nextId: number;
  /** Game time accumulated while playing (pauses freeze it; the official clock does not). */
  t: number;
  spawnIn: number;
};

export const BASE_POINTS: Readonly<Record<BubbleKind, number>> = { normal: 10, gold: 50, bomb: -30 };
export const MAX_MULTIPLIER = 5;

export const newGame = (): GameState => ({ score: 0, combo: 0, bestCombo: 0, hits: 0, misses: 0, bubbles: [], nextId: 1, t: 0, spawnIn: 0.4 });

/** 0 at the start of the round, 1 at its end. */
export const progressOf = (elapsedMs: number, limitSeconds: number): number => Math.min(1, Math.max(0, elapsedMs / (limitSeconds * 1000)));

export const multiplier = (combo: number): number => Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / 5));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Radius shrinks to 0 over the bubble's life. */
export function radiusAt(b: Bubble, t: number): number {
  const left = 1 - (t - b.born) / b.life;
  return Math.max(0, b.r * left);
}

/** Advance by dt seconds: expire bubbles, spawn new ones. */
export function step(
  s: GameState,
  dt: number,
  clock: { progress: number; elapsedSeconds: number },
  area: { width: number; top: number; height: number },
  cfg: PopRushConfig,
  random: () => number,
): void {
  s.t += dt;
  // Expired bubbles: letting a good bubble escape breaks the combo.
  const alive: Bubble[] = [];
  for (const b of s.bubbles) {
    if (s.t - b.born < b.life) alive.push(b);
    else if (b.kind !== "bomb") s.combo = 0;
  }
  s.bubbles = alive;

  s.spawnIn -= dt;
  const unit = Math.min(area.width, area.height);
  if (s.spawnIn <= 0 && s.bubbles.length < cfg.maxBubbles && unit > 40) {
    const { progress, elapsedSeconds } = clock;
    const roll = random();
    const kind: BubbleKind = elapsedSeconds >= cfg.bombsAfterSeconds && roll < lerp(0.12, 0.22, progress)
      ? "bomb" : roll > 0.93 ? "gold" : "normal";
    const r = Math.max(22, unit * lerp(0.11, 0.075, progress)) * (kind === "gold" ? 0.8 : 1);
    s.bubbles.push({
      id: s.nextId++,
      kind,
      r,
      x: r + random() * Math.max(1, area.width - 2 * r),
      y: area.top + r + random() * Math.max(1, area.height - 2 * r),
      born: s.t,
      life: lerp(2.4, 1.0, progress) * (kind === "gold" ? 0.75 : 1),
    });
    s.spawnIn = lerp(0.85, 0.32, progress) * (0.75 + random() * 0.5);
  }
}

export type TapResult = { kind: BubbleKind | "miss"; points: number; x: number; y: number };

/** Resolve a tap at (x, y): pop the top-most bubble under the finger, if any. */
export function tap(s: GameState, x: number, y: number): TapResult {
  for (let i = s.bubbles.length - 1; i >= 0; i--) {
    const b = s.bubbles[i];
    if (!b) continue;
    const r = radiusAt(b, s.t);
    // A little extra hit radius: fingers are less precise than the drawn circle.
    if (r > 0 && (x - b.x) ** 2 + (y - b.y) ** 2 <= (r + 8) ** 2) {
      s.bubbles.splice(i, 1);
      if (b.kind === "bomb") {
        s.combo = 0;
        s.score = Math.max(0, s.score + BASE_POINTS.bomb);
        return { kind: "bomb", points: BASE_POINTS.bomb, x: b.x, y: b.y };
      }
      s.combo += 1;
      s.bestCombo = Math.max(s.bestCombo, s.combo);
      s.hits += 1;
      const freshness = 1 - (s.t - b.born) / b.life; // faster taps earn a speed bonus
      const points = Math.round((BASE_POINTS[b.kind] + BASE_POINTS[b.kind] * freshness) * multiplier(s.combo));
      s.score += points;
      return { kind: b.kind, points, x: b.x, y: b.y };
    }
  }
  s.combo = 0;
  s.misses += 1;
  return { kind: "miss", points: 0, x, y };
}

/** The score submitted to the platform: a safe, non-negative integer. */
export const finalScore = (s: GameState): number => Math.max(0, Math.floor(s.score));
