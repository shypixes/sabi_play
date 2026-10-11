"use client";

import { useRef, useState } from "react";
import {
  TEST_PANEL_CONFIG_ID,
  displayBody,
  extractSessionId,
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
  cancel: "Cancelling session…",
  whoami: "Checking sign-in…",
};

type Props = {
  email: string | null;
  config: TestConfigSummary;
  registryReady: boolean;
};

export function TestPanel({ email, config, registryReady }: Props) {
  const [pending, setPending] = useState<PanelAction | null>(null);
  const [result, setResult] = useState<PanelResult | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [created, setCreated] = useState(0);
  // Blocks a second tap that lands before React re-renders the disabled button.
  const inFlight = useRef(false);

  async function run(action: PanelAction) {
    if (inFlight.current) return;
    if (action === "cancel" && !window.confirm("Cancel the last session? This changes its status in the database.")) return;
    inFlight.current = true;
    setPending(action);
    try {
      const r = await runPanelRequest(action, action === "create" || action === "whoami" ? null : sessionId);
      setResult(r);
      const id = extractSessionId(r);
      if (id) setSessionId(id);
      if (action === "create" && r.kind === "response" && r.httpOk && id) setCreated((n) => n + 1);
    } catch (err) {
      // Only reachable if the request could not be built (e.g. no session yet).
      setResult({
        kind: "network-error", action, method: "-", url: "-", requestBody: null, durationMs: 0,
        finishedAt: new Date().toISOString(), message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  const summary = result ? summarize(result) : null;
  const busy = pending !== null;

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

      <section className={styles.card} aria-labelledby="tp-result">
        <h2 id="tp-result" className={styles.h2}>Result</h2>
        <div aria-live="polite" className={styles.live}>
          {pending && (
            <p className={styles.pending}><span className={styles.spinner} aria-hidden="true" />{PENDING_LABEL[pending]}</p>
          )}
          {!pending && !result && <p className={styles.small}>No request sent yet.</p>}
          {!pending && result && summary && (
            <div className={`${styles.summary} ${styles[summary.tone]}`}>
              <strong>{summary.title}</strong>
              <ul>{summary.details.map((d) => <li key={d}>{d}</li>)}</ul>
            </div>
          )}
        </div>

        {result && (
          <>
            <p className={styles.kv}>
              <span>HTTP status</span>
              <strong>{result.kind === "response" ? result.httpStatus : "none (no response)"}</strong>
            </p>
            <p className={styles.kv}><span>Request</span><code className={styles.wrap}>{`${result.method} ${result.url}`}</code></p>
            <p className={styles.kv}><span>Time</span><strong>{`${result.durationMs} ms · ${new Date(result.finishedAt).toLocaleTimeString()}`}</strong></p>
            <p className={styles.small}>Complete response body:</p>
            <pre className={styles.pre}>{displayBody(result)}</pre>
          </>
        )}

        {sessionId && (
          <p className={styles.kv}><span>Last session</span><code className={styles.wrap}>{sessionId}</code></p>
        )}
        <div className={styles.row}>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || !sessionId} onClick={() => run("refresh")}>
            Refresh session
          </button>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || !sessionId} onClick={() => run("cancel")}>
            Cancel session
          </button>
          <button type="button" className={`secondary ${styles.btn}`} disabled={busy || !result} onClick={() => setResult(null)}>
            Clear result
          </button>
        </div>
        <p className={styles.small}>Refresh and Clear never create a session. Cancel changes the last session to CANCELLED.</p>
      </section>
    </div>
  );
}
