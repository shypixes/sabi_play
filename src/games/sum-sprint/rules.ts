/** Sum Sprint rules (pure). */

export type Question = { text: string; answer: number; choices: number[] };
export type SprintState = { score: number; streak: number; correct: number; wrong: number };

export const newSprint = (): SprintState => ({ score: 0, streak: 0, correct: 0, wrong: 0 });
export const streakMultiplier = (streak: number): number => Math.min(4, 1 + Math.floor(streak / 3));

const int = (random: () => number, min: number, max: number) => min + Math.floor(random() * (max - min + 1));

/** Harder questions as the round progresses (0..1). Choices are unique and include the answer. */
export function makeQuestion(progress: number, choiceCount: number, random: () => number): Question {
  const level = progress < 0.25 ? 0 : progress < 0.6 ? 1 : 2;
  let a: number;
  let b: number;
  let text: string;
  let answer: number;
  const op = level === 0 ? (random() < 0.7 ? "+" : "-") : level === 1 ? (random() < 0.5 ? "+" : "-") : (random() < 0.4 ? "×" : random() < 0.5 ? "+" : "-");
  if (op === "×") {
    a = int(random, 3, 12);
    b = int(random, 2, 9);
    answer = a * b;
  } else {
    const max = level === 0 ? 20 : level === 1 ? 60 : 120;
    a = int(random, 2, max);
    b = int(random, 2, max);
    if (op === "-" && b > a) [a, b] = [b, a];
    answer = op === "+" ? a + b : a - b;
  }
  text = `${a} ${op} ${b}`;
  const choices = new Set<number>([answer]);
  let spread = 1;
  while (choices.size < choiceCount) {
    const candidate = answer + (random() < 0.5 ? -1 : 1) * int(random, 1, 3 + spread);
    if (candidate >= 0) choices.add(candidate);
    spread++;
  }
  const list = [...choices];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j] as number, list[i] as number];
  }
  return { text, answer, choices: list };
}

/** Apply an answer; returns the points change. */
export function answer(s: SprintState, q: Question, choice: number): number {
  if (choice === q.answer) {
    s.streak += 1;
    s.correct += 1;
    const points = 10 * streakMultiplier(s.streak);
    s.score += points;
    return points;
  }
  s.streak = 0;
  s.wrong += 1;
  const before = s.score;
  s.score = Math.max(0, s.score - 5);
  return s.score - before;
}
