"use client";

import { REJECTION_TESTS, type RejectionTest } from "./panel-lifecycle";
import type { SessionSnapshot } from "./panel-requests";
import styles from "./test-panel.module.css";

/**
 * TEMPORARY test panel: deliberately send requests the backend should REFUSE.
 * Each run first reloads the session and only sends if the fresh state still predicts a
 * refusal; afterwards it reloads again and compares. None of these create sessions.
 */

type Props = {
  session: SessionSnapshot | null;
  busy: boolean;
  nowMs: number;
  onRun: (test: RejectionTest) => void;
};

export function RejectionTests({ session, busy, nowMs, onRun }: Props) {
  return (
    <section className={styles.card} aria-labelledby="tp-reject">
      <h2 id="tp-reject" className={styles.h2}>Rejected-operation tests</h2>
      <p className={styles.small}>
        Each test reloads the session first and sends only if it would still be refused, so it cannot move the session
        forward. Exception: a late submission makes the backend mark the session ABANDONED (that is the behaviour
        being tested). No test creates a session. Verdicts compare the real response with the expectation.
      </p>
      <ul className={styles.list}>
        {REJECTION_TESTS.map((test) => {
          const blocked = test.blockedReason(session, nowMs);
          return (
            <li key={test.id} className={styles.item}>
              <strong>{test.label}</strong>
              <p className={styles.small}>{test.description}</p>
              {blocked && <p className={styles.small}>{`Not available now: ${blocked}`}</p>}
              <button
                type="button"
                className={`secondary ${styles.btn}`}
                disabled={busy || blocked !== null}
                aria-label={`Run test: ${test.label}`}
                onClick={() => onRun(test)}
              >
                {`Run (expect ${test.expected.httpStatus})`}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
