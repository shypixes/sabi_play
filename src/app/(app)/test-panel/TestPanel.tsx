"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  TEST_PANEL_CONFIG_ID,
  canStart,
  extractSession,
  extractSessionId,
  isConfirmedSuccess,
  runPanelRequest,
  type PanelAction,
  type PanelRequestOptions,
  type PanelResult,
  type SessionSnapshot,
} from "./panel-requests";
import {
  cancelOutcome,
  completionCheck,
  deadlineInfo,
  judgeRejection,
  parseScoreInput,
  submitBlockedReason,
  targetSessionId,
  type RejectionTest,
  type Verdict,
} from "./panel-lifecycle";
import type { TestConfigSummary } from "./load-config";
import type { MySessionRow, MySessions as MySessionsData } from "./load-sessions";
import { MySessions } from "./MySessions";
import { RejectionTests } from "./RejectionTests";
import { ResultBlock, VerdictBlock } from "./ResultBlock";
import styles from "./test-panel.module.css";

/**
 * TEMPORARY competition test panel (client). Remove with the whole folder before launch.
 * No request is sent on render; every request is triggered by an explicit tap, and every
 * displayed state comes from a real API response.
 */

const PENDING_LABEL: Record<PanelAction, string> = {
  create: "Creating practice session…",
  refresh: "Loading session…",
  start: "Starting session…",
  submit: "Submitting result…",
  cancel: "Cancelling session…",
  whoami: "Checking sign-in…",
};
const REFRESH_AFTER_START = "Session started. Refreshing session details…";

const STEP_NAME: Record<PanelAction, string> = {
  create: "Create", refresh: "Refresh", start: "Start", submit: "Submit result", cancel: "Cancel", whoami: "Sign-in check",
};

type Step = { result: PanelResult; name?: string };
type Check = { title: string; verdict: Verdict };

type Props = {
  email: string | null;
  config: TestConfigSummary;
  registryReady: boolean;
  sessions: MySessionsData;
};

/** Runs one request; a request that cannot even be built is reported as a failure, never as success. */
async function safeRun(action: PanelAction, sessionId: string | null, opts: PanelRequestOptions = {}): Promise<PanelResult> {
  try {
    return await runPanelRequest(action, sessionId, fetch, undefined, opts);
  } catch (err) {
    return {
      kind: "network-error", action, method: "-", url: "-", requestBody: null, durationMs: 0,
      finishedAt: new Date().toISOString(), message: err instanceof Error ? err.message : String(err),
    };
  }
}

const formatLeft = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function TestPanel({ email, config, registryReady, sessions }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  // Results of the last tap (several steps for multi-request actions).
  const [steps, setSteps] = useState<Step[]>([]);
  const [check, setCheck] = useState<Check | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [created, setCreated] = useState(0);
  const [scoreText, setScoreText] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Blocks a second tap that lands before React re-renders the disabled buttons.
  const inFlight = useRef(false);

  // Countdown only (no requests): tick while the current session is running.
  useEffect(() => {
    if (session?.status !== "IN_PROGRESS" || !session.deadlineAt) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session?.status, session?.deadlineAt]);

  /** Track the current session exactly as the server reported it. */
  function absorb(r: PanelResult): SessionSnapshot | null {
    const snap = extractSession(r);
    if (snap) {
      setSessionId(snap.sessionId);
      setSession(snap);
    }
    return snap;
  }

  /** One user action at a time; repeated taps while running are ignored. */
  async function exclusive(key: string, label: string, fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(key);
    setPendingLabel(label);
    setCheck(null);
    try {
      await fn();
    } finally {
      inFlight.current = false;
      setPending(null);
      setPendingLabel("");
    }
  }

  /** Re-render the server part of the page (session list). Not an API call to the competition routes. */
  const reloadList = () => router.refresh();

  function whoami() {
    void exclusive("whoami", PENDING_LABEL.whoami, async () => {
      setSteps([{ result: await safeRun("whoami", null) }]);
    });
  }

  function create() {
    void exclusive("create", PENDING_LABEL.create, async () => {
      const r = await safeRun("create", null);
      setSteps([{ result: r }]);
      const snap = absorb(r);
      if (snap) {
        setCreated((n) => n + 1);
        reloadList();
      }
    });
  }

  function load(id: string, key = "refresh") {
    void exclusive(key, PENDING_LABEL.refresh, async () => {
      const r = await safeRun("refresh", id);
      setSteps([{ result: r }]);
      absorb(r);
    });
  }

  function start() {
    const id = sessionId;
    if (!canStart(id, session?.status ?? null)) return;
    void exclusive("start", PENDING_LABEL.start, async () => {
      const started = await safeRun("start", id);
      setSteps([{ result: started }]);
      absorb(started);
      if (!isConfirmedSuccess(started)) return; // no refresh, nothing assumed
      setPendingLabel(REFRESH_AFTER_START);
      const refreshed = await safeRun("refresh", extractSessionId(started) ?? id);
      setSteps([{ result: started }, { result: refreshed }]);
      absorb(refreshed);
      reloadList();
    });
  }

  function submit() {
    const id = sessionId;
    const parsed = parseScoreInput(scoreText);
    if (!id || !parsed.ok || submitBlockedReason(session, Date.now()) !== null) return;
    if (inFlight.current) return;
    if (!window.confirm(`Submit score ${parsed.score} for this session? A result can only be submitted once; it completes the practice session (stored as UNVERIFIED).`)) return;
    void exclusive("submit", PENDING_LABEL.submit, async () => {
      const submitted = await safeRun("submit", id, { score: parsed.score });
      setSteps([{ result: submitted }]);
      absorb(submitted);
      reloadList();
      if (!isConfirmedSuccess(submitted)) return; // failure shown as is; no completion claimed
      setPendingLabel("Result accepted. Reloading the session to confirm completion…");
      const refreshed = await safeRun("refresh", id);
      setSteps([{ result: submitted }, { result: refreshed }]);
      const snap = absorb(refreshed);
      setCheck({ title: "Session completion (from the reloaded session)", verdict: completionCheck(parsed.score, snap) });
    });
  }

  function cancelSession(id: string, knownStatus: string | null) {
    const outcome = cancelOutcome(knownStatus);
    if (inFlight.current) return;
    const what = outcome
      ? `It will become ${outcome} (${knownStatus} → ${outcome}).`
      : "The panel expects the server to refuse this.";
    if (!window.confirm(`Cancel session ${id.slice(0, 8)}…? ${what} Nothing is deleted; the record keeps its history.`)) return;
    void exclusive("cancel", PENDING_LABEL.cancel, async () => {
      const cancelled = await safeRun("cancel", id);
      setSteps([{ result: cancelled }]);
      absorb(cancelled);
      reloadList();
      if (!isConfirmedSuccess(cancelled)) return;
      setPendingLabel("Cancelled. Reloading the session…");
      const refreshed = await safeRun("refresh", id);
      setSteps([{ result: cancelled }, { result: refreshed }]);
      absorb(refreshed);
    });
  }

  function cancelRow(row: MySessionRow) {
    cancelSession(row.sessionId, row.status);
  }

  function runRejection(test: RejectionTest) {
    const target = targetSessionId(test, sessionId);
    if (!target) return;
    void exclusive(`reject:${test.id}`, `Running test: ${test.label}…`, async () => {
      const opts = test.score === undefined ? {} : { score: test.score };
      if (test.target === "unknown") {
        const r = await safeRun(test.action, target, opts);
        setSteps([{ result: r, name: `Test request: ${STEP_NAME[test.action]}` }]);
        setCheck({ title: test.label, verdict: judgeRejection(test, r, null, null) });
        return;
      }
      // 1. Pre-check: reload and only continue if the fresh state still predicts a refusal.
      const pre = await safeRun("refresh", target);
      const before = absorb(pre);
      const blocked = test.blockedReason(before, Date.now());
      if (!before || blocked) {
        setSteps([{ result: pre, name: "Pre-check: reload session" }]);
        setCheck({
          title: test.label,
          verdict: { outcome: "inconclusive", lines: [`Not sent. ${before ? blocked : "The session could not be loaded."}`] },
        });
        return;
      }
      // 2. The request that should be refused, then 3. reload and compare.
      const res = await safeRun(test.action, target, opts);
      const post = await safeRun("refresh", target);
      const after = absorb(post);
      setSteps([
        { result: pre, name: "Pre-check: reload session" },
        { result: res, name: `Test request: ${STEP_NAME[test.action]}` },
        { result: post, name: "Post-check: reload session" },
      ]);
      setCheck({ title: test.label, verdict: judgeRejection(test, res, before, after) });
      reloadList();
    });
  }

  const busy = pending !== null;
  const startAllowed = canStart(sessionId, session?.status ?? null);
  const startBlockedReason = !sessionId
    ? "Create a session first."
    : session?.status !== "READY"
      ? `Start needs status READY; this session is ${session?.status ?? "unknown"}. Create a new session to test Start again.`
      : null;
  const score = parseScoreInput(scoreText);
  const submitBlocked = submitBlockedReason(session, nowMs);
  const deadline = session?.status === "IN_PROGRESS" ? deadlineInfo(session.deadlineAt, nowMs) : null;
  const currentCancel = cancelOutcome(session?.status);

  return (
    <div className="stack-lg">
      <div className={styles.banner} role="note">
        <strong>Temporary test tool.</strong> For testing the competition API only. It will be removed before launch.
      </div>

      <section className={styles.card} aria-labelledby="tp-auth">
        <h2 id="tp-auth" className={styles.h2}>Authentication</h2>
        <p className={styles.kv}><span>Status</span><strong className={styles.ok}>Signed in</strong></p>
        {email && <p className={styles.kv}><span>Account</span><strong className={styles.wrap}>{email}</strong></p>}
        <button type="button" className={`secondary ${styles.btn}`} disabled={busy} onClick={whoami}>
          Check sign-in with server
        </button>
      </section>

      <section className={styles.card} aria-labelledby="tp-config">
        <h2 id="tp-config" className={styles.h2}>Test configuration</h2>
        <p className={styles.kv}><span>Config ID</span><code className={styles.wrap}>{TEST_PANEL_CONFIG_ID}</code></p>
        {config.state === "found" ? (
          <>
            <p className={styles.kv}><span>Label</span><strong>{config.label}</strong></p>
            <p className={styles.kv}><span>Game</span><strong>{config.gameId}</strong></p>
            <p className={styles.kv}><span>Format · mode</span><strong>{`${config.format} · ${config.mode}`}</strong></p>
            <p className={styles.kv}><span>Entry fee</span><strong>{`${config.entryFee} PlayCoins`}</strong></p>
            <p className={styles.kv}><span>Time limit</span><strong>{`${config.timeLimitSeconds}s (+30s grace for results)`}</strong></p>
            <p className={styles.kv}>
              <span>Enabled</span>
              <strong className={config.enabled ? styles.ok : styles.bad}>{config.enabled ? "Yes" : "No (creation will fail with 409)"}</strong>
            </p>
          </>
        ) : (
          <p className={styles.bad}>
            {config.state === "missing" && "Not found in the Supabase project this deployment uses."}
            {config.state === "invalid" && "Found, but the row did not pass validation."}
            {config.state === "error" && "Could not load the configuration (see server logs)."}
          </p>
        )}
        <p className={styles.kv}>
          <span>Registry</span>
          <strong className={registryReady ? styles.ok : styles.bad}>
            {registryReady ? "test-game · Score Attack available" : "test-game not available in this build"}
          </strong>
        </p>
      </section>

      <section className={styles.card} aria-labelledby="tp-create">
        <h2 id="tp-create" className={styles.h2}>Create practice session</h2>
        <p className={styles.warn}>
          Each successful tap creates a <strong>real session in the database</strong>. It is free (no PlayCoins), but
          it counts towards the limit of 3 open sessions per player.
        </p>
        <p className={styles.small}>
          Sends <code>POST /api/competitions/sessions</code> with <code>{`{"configId":"${TEST_PANEL_CONFIG_ID}"}`}</code>.
        </p>
        <button type="button" className={styles.btn} disabled={busy} aria-busy={pending === "create"} onClick={create}>
          {pending === "create" ? "Creating…" : "Create Practice Session"}
        </button>
        {created > 0 && <p className={styles.small}>Sessions created from this page since it loaded: {created}</p>}
      </section>

      <section className={styles.card} aria-labelledby="tp-session">
        <h2 id="tp-session" className={styles.h2}>Current session</h2>
        <p className={styles.kv}><span>Session ID</span><code className={styles.wrap}>{sessionId ?? "none yet"}</code></p>
        <p className={styles.kv}>
          <span>Status (last reported)</span>
          <strong className={session?.status === "READY" || session?.status === "COMPLETED" ? styles.ok : undefined}>{session?.status ?? "-"}</strong>
        </p>
        {session && (
          <>
            <p className={styles.kv}><span>Validation · settlement</span><strong>{`${session.validationStatus ?? "-"} · ${session.settlementStatus ?? "-"}`}</strong></p>
            {session.startedAt && <p className={styles.kv}><span>Started</span><strong>{new Date(session.startedAt).toLocaleTimeString()}</strong></p>}
            {session.deadlineAt && <p className={styles.kv}><span>Deadline</span><strong>{new Date(session.deadlineAt).toLocaleTimeString()}</strong></p>}
            {deadline && (
              <p className={styles.kv}>
                <span>Time left (device clock)</span>
                <strong className={deadline.passed ? styles.bad : styles.ok}>
                  {deadline.passed ? `Deadline passed ${formatLeft(-deadline.secondsLeft)} ago` : formatLeft(deadline.secondsLeft)}
                </strong>
              </p>
            )}
            <p className={styles.kv}><span>Stored result</span><strong>{session.hasResult ? String(session.resultScore ?? "(no score)") : "none"}</strong></p>
          </>
        )}

        <h3 className={styles.h3}>1. Start</h3>
        <p className={styles.small}>
          Sends <code>POST /api/competitions/sessions/&lt;session id&gt;/start</code> with <code>{"{}"}</code>, then reloads
          the session. Starting begins the session timer in the database (READY → IN_PROGRESS).
        </p>
        <button type="button" className={styles.btn} disabled={busy || !startAllowed} aria-busy={pending === "start"} onClick={start}>
          {pending === "start" ? "Starting…" : "Start Session"}
        </button>
        {startBlockedReason && <p className={styles.small}>{startBlockedReason}</p>}

        <h3 className={styles.h3}>2. Submit result (Score Attack)</h3>
        <p className={styles.small}>
          Sends <code>POST …/result</code> with <code>{`{"format":"SCORE_ATTACK","score":<whole number 0 to 1,000,000,000,000>}`}</code>.
          For practice, an accepted result completes the session in the same step and is stored as UNVERIFIED (never
          verified; no payout).
        </p>
        <label className={styles.field}>
          <span>Score</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            placeholder="e.g. 4200"
            value={scoreText}
            onChange={(e) => setScoreText(e.target.value)}
            aria-invalid={scoreText !== "" && !score.ok}
          />
        </label>
        {scoreText !== "" && !score.ok && <p className={styles.bad}>{score.message}</p>}
        <button
          type="button"
          className={styles.btn}
          disabled={busy || !score.ok || submitBlocked !== null}
          aria-busy={pending === "submit"}
          onClick={submit}
        >
          {pending === "submit" ? "Submitting…" : "Submit Result"}
        </button>
        {submitBlocked && <p className={styles.small}>{submitBlocked}</p>}

        <h3 className={styles.h3}>3. Cancel or reload</h3>
        <div className={styles.row2}>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || !sessionId} onClick={() => sessionId && load(sessionId)}>
            Refresh session
          </button>
          <button
            type="button"
            className={`secondary ${styles.btn}`}
            disabled={busy || !sessionId}
            onClick={() => sessionId && cancelSession(sessionId, session?.status ?? null)}
          >
            Cancel session
          </button>
        </div>
        {sessionId && (
          <p className={styles.small}>
            {currentCancel
              ? `Cancel would make this session ${currentCancel}.`
              : `This session is ${session?.status ?? "unknown"}; the backend refuses to cancel it (see the rejection tests).`}
          </p>
        )}
      </section>

      <MySessions
        data={sessions}
        currentId={sessionId}
        busy={busy}
        onUse={(id) => load(id, `use:${id}`)}
        onCancel={cancelRow}
        onReload={reloadList}
      />

      <RejectionTests session={session} busy={busy} nowMs={nowMs} onRun={runRejection} />

      <section className={styles.card} aria-labelledby="tp-result">
        <h2 id="tp-result" className={styles.h2}>Result</h2>
        <div aria-live="polite" className={styles.live}>
          {pending && (
            <p className={styles.pending}><span className={styles.spinner} aria-hidden="true" />{pendingLabel}</p>
          )}
          {!pending && steps.length === 0 && <p className={styles.small}>No request sent yet.</p>}
          {!pending && check && <VerdictBlock title={check.title} verdict={check.verdict} />}
        </div>

        {steps.map((s, i) => (
          <ResultBlock
            key={`${s.result.action}-${s.result.finishedAt}-${i}`}
            result={s.result}
            step={steps.length > 1 || s.name ? `Step ${i + 1} of ${steps.length}: ${s.name ?? STEP_NAME[s.result.action]}` : null}
          />
        ))}

        <button type="button" className={`secondary ${styles.btn}`} disabled={busy || steps.length === 0} onClick={() => { setSteps([]); setCheck(null); }}>
          Clear result
        </button>
        <p className={styles.small}>
          Refresh, Start, Submit, the tests and Clear never create a session. Nothing is deleted by any button.
        </p>
      </section>
    </div>
  );
}
