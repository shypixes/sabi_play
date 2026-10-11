"use client";

import { useRef, useState } from "react";
import {
  TEST_PANEL_CONFIG_ID,
  canStart,
  displayBody,
  extractSessionId,
  extractSessionStatus,
  runPanelRequest,
  summarize,
  type PanelAction,
  type PanelResult,
} from "./panel-requests";
import type { TestConfigSummary } from "./load-config";
import styles from "./test-panel.module.css";

/**
 * TEMPORARY competition test panel (client). Remove with the whole folder before launch.
 * No request is sent on render; every request is triggered by an explicit tap.
 */

const PENDING_LABEL: Record<PanelAction, string> = {
  create: "Creating practice session…",
  refresh: "Loading session…",
  start: "Starting session…",
  cancel: "Cancelling session…",
  whoami: "Checking sign-in…",
};
const REFRESH_AFTER_START = "Session started. Refreshing session details…";

const STEP_NAME: Record<PanelAction, string> = {
  create: "Create", refresh: "Refresh", start: "Start", cancel: "Cancel", whoami: "Sign-in check",
};

type Props = {
  email: string | null;
  config: TestConfigSummary;
  registryReady: boolean;
};

/** Runs one request; a request that cannot even be built is reported as a failure, never as success. */
async function safeRun(action: PanelAction, sessionId: string | null): Promise<PanelResult> {
  try {
    return await runPanelRequest(action, sessionId);
  } catch (err) {
    return {
      kind: "network-error", action, method: "-", url: "-", requestBody: null, durationMs: 0,
      finishedAt: new Date().toISOString(), message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function TestPanel({ email, config, registryReady }: Props) {
  const [pending, setPending] = useState<PanelAction | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  // Results of the last tap: one step, or two for Start (start response, then refreshed details).
  const [results, setResults] = useState<PanelResult[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [created, setCreated] = useState(0);
  // Blocks a second tap that lands before React re-renders the disabled buttons.
  const inFlight = useRef(false);

  /** Track the session id and its last status as reported by the server. */
  function absorb(r: PanelResult) {
    const id = extractSessionId(r);
    if (id) setSessionId(id);
    const status = extractSessionStatus(r);
    if (status) setSessionStatus(status);
    return id;
  }

  function begin(action: PanelAction): boolean {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(action);
    setPendingLabel(PENDING_LABEL[action]);
    return true;
  }
  function end() {
    inFlight.current = false;
    setPending(null);
    setPendingLabel("");
  }

  async function run(action: Exclude<PanelAction, "start">) {
    if (inFlight.current) return;
    if (action === "cancel" && !window.confirm("Cancel the last session? This ends it in the database (READY → CANCELLED, IN_PROGRESS → ABANDONED).")) return;
    if (!begin(action)) return;
    try {
      const r = await safeRun(action, action === "create" || action === "whoami" ? null : sessionId);
      setResults([r]);
      const id = absorb(r);
      if (action === "create" && r.kind === "response" && r.httpOk && id) setCreated((n) => n + 1);
    } finally {
      end();
    }
  }

  /** POST .../start for the displayed session; after a confirmed success, GET the session again. */
  async function startSession() {
    const id = sessionId;
    if (inFlight.current || !canStart(id, sessionStatus)) return;
    if (!begin("start")) return;
    try {
      const started = await safeRun("start", id);
      setResults([started]);
      absorb(started);
      if (summarize(started).tone !== "success") return; // no refresh, nothing assumed
      setPendingLabel(REFRESH_AFTER_START);
      const refreshed = await safeRun("refresh", extractSessionId(started) ?? id);
      setResults([started, refreshed]);
      absorb(refreshed);
    } finally {
      end();
    }
  }

  const busy = pending !== null;
  const startAllowed = canStart(sessionId, sessionStatus);
  const startBlockedReason = !sessionId
    ? "Create a session first."
    : sessionStatus !== "READY"
      ? `Start needs status READY; this session is ${sessionStatus ?? "unknown"}. Create a new session to test Start again.`
      : null;

  return (
    <div className="stack-lg">
      <div className={styles.banner} role="note">
        <strong>Temporary test tool.</strong> For testing the competition API only. It will be removed before launch.
      </div>

      <section className={styles.card} aria-labelledby="tp-auth">
        <h2 id="tp-auth" className={styles.h2}>Authentication</h2>
        <p className={styles.kv}><span>Status</span><strong className={styles.ok}>Signed in</strong></p>
        {email && <p className={styles.kv}><span>Account</span><strong className={styles.wrap}>{email}</strong></p>}
        <button type="button" className={`secondary ${styles.btn}`} disabled={busy} onClick={() => run("whoami")}>
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
            <p className={styles.kv}><span>Time limit</span><strong>{`${config.timeLimitSeconds}s`}</strong></p>
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
        <button type="button" className={styles.btn} disabled={busy} aria-busy={pending === "create"} onClick={() => run("create")}>
          {pending === "create" ? "Creating…" : "Create Practice Session"}
        </button>
        {created > 0 && <p className={styles.small}>Sessions created from this page since it loaded: {created}</p>}
      </section>

      <section className={styles.card} aria-labelledby="tp-session">
        <h2 id="tp-session" className={styles.h2}>Current session</h2>
        <p className={styles.kv}><span>Session ID</span><code className={styles.wrap}>{sessionId ?? "none yet"}</code></p>
        <p className={styles.kv}>
          <span>Status (last reported)</span>
          <strong className={sessionStatus === "READY" ? styles.ok : undefined}>{sessionStatus ?? "-"}</strong>
        </p>
        <p className={styles.small}>
          Sends <code>POST /api/competitions/sessions/&lt;session id&gt;/start</code> with <code>{"{}"}</code>, then reloads
          the session. Starting begins the session timer in the database (READY → IN_PROGRESS).
        </p>
        <button type="button" className={styles.btn} disabled={busy || !startAllowed} aria-busy={pending === "start"} onClick={startSession}>
          {pending === "start" ? "Starting…" : "Start Session"}
        </button>
        {startBlockedReason && <p className={styles.small}>{startBlockedReason}</p>}
      </section>

      <section className={styles.card} aria-labelledby="tp-result">
        <h2 id="tp-result" className={styles.h2}>Result</h2>
        <div aria-live="polite" className={styles.live}>
          {pending && (
            <p className={styles.pending}><span className={styles.spinner} aria-hidden="true" />{pendingLabel}</p>
          )}
          {!pending && results.length === 0 && <p className={styles.small}>No request sent yet.</p>}
        </div>

        {results.map((r, i) => (
          <ResultBlock key={`${r.action}-${r.finishedAt}-${i}`} result={r} step={results.length > 1 ? `Step ${i + 1} of ${results.length}: ${STEP_NAME[r.action]}` : null} />
        ))}

        <div className={styles.row}>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || !sessionId} onClick={() => run("refresh")}>
            Refresh session
          </button>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || !sessionId} onClick={() => run("cancel")}>
            Cancel session
          </button>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || results.length === 0} onClick={() => setResults([])}>
            Clear result
          </button>
        </div>
        <p className={styles.small}>
          Refresh, Start and Clear never create a session. Cancel ends the last session (READY → CANCELLED, IN_PROGRESS → ABANDONED).
        </p>
      </section>
    </div>
  );
}

function ResultBlock({ result, step }: { result: PanelResult; step: string | null }) {
  const summary = summarize(result);
  return (
    <div className={styles.step}>
      {step && <h3 className={styles.h3}>{step}</h3>}
      <div className={`${styles.summary} ${styles[summary.tone]}`}>
        <strong>{summary.title}</strong>
        <ul>{summary.details.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
      <p className={styles.kv}>
        <span>HTTP status</span>
        <strong>{result.kind === "response" ? result.httpStatus : "none (no response)"}</strong>
      </p>
      <p className={styles.kv}><span>Request</span><code className={styles.wrap}>{`${result.method} ${result.url}`}</code></p>
      <p className={styles.kv}><span>Time</span><strong>{`${result.durationMs} ms · ${new Date(result.finishedAt).toLocaleTimeString()}`}</strong></p>
      <p className={styles.small}>Complete response body:</p>
      <pre className={styles.pre}>{displayBody(result)}</pre>
    </div>
  );
}
