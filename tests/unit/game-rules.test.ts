import { describe, expect, it } from "vitest";
import { MAX_MULTIPLIER, finalScore, multiplier, newGame, radiusAt, step, tap, type Bubble } from "@/games/pop-rush/rules";
import { answer, makeQuestion, newSprint, streakMultiplier } from "@/games/sum-sprint/rules";

// UNIT: the games' own scoring rules (pure; no SDK, no platform).

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};
const bubble = (over: Partial<Bubble> = {}): Bubble => ({ id: 1, kind: "normal", x: 100, y: 100, r: 30, born: 0, life: 2, ...over });

describe("Pop Rush rules", () => {
  it("rewards fast hits, builds combos and caps the multiplier", () => {
    const s = newGame();
    s.bubbles = [bubble()];
    const hit = tap(s, 100, 100);
    expect(hit).toMatchObject({ kind: "normal", points: 20 }); // 10 base + 10 full-freshness bonus, x1
    expect(s).toMatchObject({ score: 20, combo: 1, hits: 1 });
    expect(multiplier(4)).toBe(1);
    expect(multiplier(5)).toBe(2);
    expect(multiplier(1000)).toBe(MAX_MULTIPLIER);
  });

  it("misses and bombs break the combo; bombs cost points but never below zero", () => {
    const s = newGame();
    s.combo = 7;
    expect(tap(s, 5, 5).kind).toBe("miss");
    expect(s.combo).toBe(0);
    s.bubbles = [bubble({ kind: "bomb" })];
    s.combo = 3;
    expect(tap(s, 100, 100)).toMatchObject({ kind: "bomb", points: -30 });
    expect(s).toMatchObject({ score: 0, combo: 0 });
  });

  it("bubbles shrink and expire; an escaped good bubble breaks the combo", () => {
    const s = newGame();
    s.bubbles = [bubble({ life: 1 })];
    s.combo = 4;
    expect(radiusAt(s.bubbles[0]!, 0.5)).toBe(15);
    step(s, 1.01, { progress: 0, elapsedSeconds: 1 }, { width: 400, top: 64, height: 600 }, { maxBubbles: 0, bombsAfterSeconds: 20 }, seq(0.5));
    expect(s.bubbles).toHaveLength(0);
    expect(s.combo).toBe(0);
  });

  it("spawns inside the play area, no bombs before the configured time", () => {
    const s = newGame();
    const area = { width: 360, top: 64, height: 500 };
    for (let i = 0; i < 200; i++) step(s, 0.05, { progress: 0.05, elapsedSeconds: 9 }, area, { maxBubbles: 50, bombsAfterSeconds: 20 }, Math.random);
    expect(s.bubbles.length).toBeGreaterThan(0);
    for (const b of s.bubbles) {
      expect(b.kind).not.toBe("bomb");
      expect(b.x - b.r).toBeGreaterThanOrEqual(0);
      expect(b.x + b.r).toBeLessThanOrEqual(area.width + 0.001);
      expect(b.y - b.r).toBeGreaterThanOrEqual(area.top);
    }
  });

  it("the submitted score is always a non-negative integer", () => {
    const s = newGame();
    s.score = 12.7;
    expect(finalScore(s)).toBe(12);
    s.score = -3;
    expect(finalScore(s)).toBe(0);
  });
});

describe("Sum Sprint rules", () => {
  it("generates unique choices that include the answer", () => {
    for (let i = 0; i < 300; i++) {
      const q = makeQuestion(i / 300, 4, Math.random);
      expect(new Set(q.choices).size).toBe(4);
      expect(q.choices).toContain(q.answer);
      expect(q.choices.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
    }
  });

  it("scores streaks and penalises wrong answers without going negative", () => {
    const s = newSprint();
    const q = { text: "1 + 1", answer: 2, choices: [1, 2, 3, 4] };
    expect([answer(s, q, 2), answer(s, q, 2), answer(s, q, 2)]).toEqual([10, 10, 20]);
    expect(streakMultiplier(100)).toBe(4);
    expect(answer(s, q, 3)).toBe(-5);
    expect(s).toMatchObject({ score: 35, streak: 0, correct: 3, wrong: 1 });
    const empty = newSprint();
    expect(answer(empty, q, 1)).toBe(0);
    expect(empty.score).toBe(0);
  });
});
