"use client";

import type { MySessionRow, MySessions as MySessionsData } from "./load-sessions";
import styles from "./test-panel.module.css";

/**
 * TEMPORARY test panel: the signed-in player's own sessions, for safe cleanup.
 * Loaded on the server under RLS (created_by = you). Nothing is requested or cancelled
 * automatically; Reload list re-renders the page on the server.
 */

type Props = {
  data: MySessionsData;
  currentId: string | null;
  busy: boolean;
  onUse: (id: string) => void;
  onCancel: (row: MySessionRow) => void;
  onReload: () => void;
};

const short = (id: string) => id.slice(0, 8);
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");

export function MySessions({ data, currentId, busy, onUse, onCancel, onReload }: Props) {
  return (
    <section className={styles.card} aria-labelledby="tp-mine">
      <h2 id="tp-mine" className={styles.h2}>Your sessions</h2>
      {data.state === "error" ? (
        <p className={styles.bad}>Could not load your sessions (see server logs).</p>
      ) : (
        <>
          <p className={styles.kv}>
            <span>Open sessions counting toward the limit</span>
            <strong className={data.openCount >= data.maxOpen ? styles.bad : styles.ok}>{`${data.openCount} / ${data.maxOpen}`}</strong>
          </p>
          <p className={styles.small}>
            {`Your ${data.shownLimit} most recent sessions, loaded ${new Date(data.loadedAt).toLocaleTimeString()}. `}
            In-progress sessions stop counting once their deadline passes, but their status stays IN_PROGRESS until you
            submit or cancel (there is no automatic expiry). Cancelling never deletes anything: READY → CANCELLED,
            IN_PROGRESS → ABANDONED.
          </p>
          {data.rows.length === 0 && <p className={styles.small}>You have no sessions yet.</p>}
          <ul className={styles.list}>
            {data.rows.map((row) => (
              <li key={row.sessionId} className={`${styles.item} ${row.sessionId === currentId ? styles.current : ""}`}>
                <p className={styles.kv}>
                  <span>Session</span>
                  <code className={styles.wrap}>{row.sessionId}</code>
                </p>
                <p className={styles.kv}>
                  <span>Status</span>
                  <strong>{row.status}{row.status === "IN_PROGRESS" && row.deadlinePassed ? " · deadline passed" : ""}</strong>
                </p>
                <p className={styles.small}>
                  {`${row.gameId} · ${row.format} · ${row.mode}${row.isTestConfig ? " · test config" : ""} · created ${time(row.createdAt)}`}
                  {row.deadlineAt ? ` · deadline ${time(row.deadlineAt)}` : ""}
                </p>
                <p className={styles.small}>
                  {row.countsTowardLimit ? "Counts toward the open-session limit." : "Does not count toward the limit."}
                  {" "}
                  {row.cancelOutcome ? `Cancel → ${row.cancelOutcome}.` : "Finished: cannot be cancelled."}
                </p>
                <div className={styles.row2}>
                  <button
                    type="button"
                    className={`secondary ${styles.btn}`}
                    disabled={busy}
                    aria-label={`Use session ${short(row.sessionId)}`}
                    onClick={() => onUse(row.sessionId)}
                  >
                    {row.sessionId === currentId ? "Reload" : "Use"}
                  </button>
                  <button
                    type="button"
                    className={`secondary ${styles.btn}`}
                    disabled={busy || row.cancelOutcome === null}
                    aria-label={`Cancel session ${short(row.sessionId)}`}
                    onClick={() => onCancel(row)}
                  >
                    {row.cancelOutcome ? `Cancel (→ ${row.cancelOutcome})` : "Cannot cancel"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className={`secondary ${styles.btn}`} disabled={busy} onClick={onReload}>
        Reload list
      </button>
    </section>
  );
}
