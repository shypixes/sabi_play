import { defineGame, type GameSdk, type OfficialTiming, type SubmitOutcome } from "@/game-sdk";
import { answer, makeQuestion, newSprint, streakMultiplier, type Question, type SprintState } from "./rules";

/** Sum Sprint: DOM-rendered, same public SDK lifecycle as every game. */

const CSS = `
.ss{position:absolute;inset:0;display:grid;grid-template-rows:auto 1fr auto;gap:12px;padding:16px;box-sizing:border-box;
  background:#0f1115;color:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;user-select:none;-webkit-user-select:none}
.ss-hud{display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:1.25rem}
.ss-time.low{color:#f87171}.ss-mult{color:#fbbf24}
.ss-main{display:grid;align-content:center;justify-items:center;gap:8px;text-align:center}
.ss-q{font-size:clamp(2.2rem,12vw,3.5rem);font-weight:800;letter-spacing:-.02em}
.ss-note{color:#a1a1aa;max-width:32ch}
.ss-flash{min-height:1.5em;font-weight:800}
.ss-flash.good{color:#4ade80}.ss-flash.bad{color:#f87171}
.ss-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ss-grid button{font:inherit;font-size:1.6rem;font-weight:800;min-height:72px;border-radius:14px;border:1px solid #2a2f3a;
  background:#181b22;color:#f4f4f5;touch-action:manipulation}
.ss-grid button:active{background:#232835}
.ss-grid button:disabled{opacity:.35}
.ss-key{display:block;font-size:.7rem;color:#a1a1aa;font-weight:600}
`;

export default defineGame({
  mount(root: HTMLElement, sdk: GameSdk) {
    const choiceCount = typeof sdk.context.gameConfig.choices === "number" && sdk.context.gameConfig.choices >= 2 && sdk.context.gameConfig.choices <= 6
      ? sdk.context.gameConfig.choices : 4;

    const el = document.createElement("div");
    el.className = "ss";
    el.innerHTML = `<style>${CSS}</style>
      <div class="ss-hud"><span class="ss-score">0</span><span class="ss-time">3:00</span><span class="ss-mult">x1</span></div>
      <div class="ss-main" aria-live="polite"><div class="ss-q">Sum Sprint</div><div class="ss-flash"></div>
        <p class="ss-note">Answer as many sums as you can in 3 minutes. Streaks multiply your points.</p></div>
      <div class="ss-grid"></div>`;
    root.appendChild(el);
    const $ = <T extends Element>(sel: string) => el.querySelector(sel) as T;
    const scoreEl = $<HTMLElement>(".ss-score");
    const timeEl = $<HTMLElement>(".ss-time");
    const multEl = $<HTMLElement>(".ss-mult");
    const qEl = $<HTMLElement>(".ss-q");
    const flashEl = $<HTMLElement>(".ss-flash");
    const noteEl = $<HTMLElement>(".ss-note");
    const grid = $<HTMLElement>(".ss-grid");

    let state: SprintState = newSprint();
    let timing: OfficialTiming = sdk.timing();
    let question: Question | null = null;
    let playing = false;
    let finished = false;
    let ticker = 0;

    const buttons: HTMLButtonElement[] = [];
    for (let i = 0; i < choiceCount; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.disabled = true;
      b.addEventListener("click", () => choose(i));
      grid.appendChild(b);
      buttons.push(b);
    }

    const fmt = (ms: number) => {
      const s = Math.ceil(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };

    function render() {
      scoreEl.textContent = String(state.score);
      multEl.textContent = `x${streakMultiplier(state.streak)}`;
      const left = timing.remainingMs();
      timeEl.textContent = left === null ? "3:00" : fmt(left);
      timeEl.classList.toggle("low", left !== null && left < 10_000);
      buttons.forEach((b, i) => {
        const v = question?.choices[i];
        b.innerHTML = v === undefined ? "" : `${v}<span class="ss-key">${i + 1}</span>`;
        b.disabled = !playing || v === undefined;
      });
      if (question && playing) qEl.textContent = question.text;
    }

    function next() {
      const left = timing.remainingMs() ?? 0;
      const progress = 1 - left / (timing.timeLimitSeconds * 1000);
      question = makeQuestion(progress, choiceCount, Math.random);
      render();
    }

    function choose(i: number) {
      if (!playing || !question) return;
      const value = question.choices[i];
      if (value === undefined) return;
      const delta = answer(state, question, value);
      flashEl.textContent = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "✕";
      flashEl.className = `ss-flash ${delta > 0 ? "good" : "bad"}`;
      next();
    }

    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choiceCount) choose(n - 1);
    };
    window.addEventListener("keydown", onKey);

    function tick() {
      if (!playing) return;
      if ((timing.remainingMs() ?? 0) <= 0) {
        finish();
        return;
      }
      render();
    }
    const startTicker = () => {
      if (!ticker) ticker = window.setInterval(tick, 200);
    };
    const stopTicker = () => {
      window.clearInterval(ticker);
      ticker = 0;
    };

    function finish() {
      if (finished) return;
      finished = true;
      playing = false;
      stopTicker();
      question = null;
      render();
      qEl.textContent = `Score ${state.score}`;
      noteEl.textContent = "Time! Saving your result…";
      sdk.submitResult({ score: state.score }).then(showOutcome, (err: unknown) => {
        noteEl.textContent = err instanceof Error ? err.message : "The result could not be submitted.";
      });
    }

    function showOutcome(o: SubmitOutcome) {
      qEl.textContent = `Score ${o.status === "completed" || o.status === "pending_verification" ? o.score : state.score}`;
      noteEl.textContent = o.status === "completed"
        ? `Saved. Practice result (${o.validation.toLowerCase()}); no rewards for practice.`
        : o.status === "pending_verification" ? "Submitted. Waiting for verification." : o.message;
      flashEl.textContent = "";
    }

    const offs = [
      sdk.on("start", (t) => {
        timing = t;
        state = newSprint();
        playing = true;
        noteEl.textContent = "";
        next();
        startTicker();
      }),
      sdk.on("pause", () => {
        playing = false;
        stopTicker();
        noteEl.textContent = "Paused. The timer keeps running on the server.";
        render();
      }),
      sdk.on("resume", (t) => {
        if (finished) return;
        timing = t;
        playing = true;
        noteEl.textContent = "";
        render();
        startTicker();
        tick();
      }),
      sdk.on("result", showOutcome),
      sdk.on("terminate", (info) => {
        playing = false;
        stopTicker();
        render();
        if (!finished) noteEl.textContent = info.message;
      }),
    ];

    render();
    sdk.ready();

    return {
      dispose() {
        stopTicker();
        window.removeEventListener("keydown", onKey);
        for (const off of offs) off();
        el.remove();
      },
    };
  },
});
