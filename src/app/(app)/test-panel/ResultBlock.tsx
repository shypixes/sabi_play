"use client";

import { displayBody, summarize, type PanelResult } from "./panel-requests";
import type { Verdict } from "./panel-lifecycle";
import styles from "./test-panel.module.css";

/** TEMPORARY test panel: one request/response, shown completely. */
export function ResultBlock({ result, step }: { result: PanelResult; step: string | null }) {
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
      {result.requestBody !== null && (
        <p className={styles.kv}><span>Request body</span><code className={styles.wrap}>{result.requestBody}</code></p>
      )}
      <p className={styles.kv}><span>Time</span><strong>{`${result.durationMs} ms · ${new Date(result.finishedAt).toLocaleTimeString()}`}</strong></p>
      <p className={styles.small}>Complete response body:</p>
      <pre className={styles.pre}>{displayBody(result)}</pre>
    </div>
  );
}

const VERDICT_TONE = { pass: "success", fail: "error", inconclusive: "warning" } as const;
const VERDICT_WORD = { pass: "PASS", fail: "FAIL", inconclusive: "INCONCLUSIVE" } as const;

/** Outcome of a check computed from real responses (rejection test or completion check). */
export function VerdictBlock({ title, verdict }: { title: string; verdict: Verdict }) {
  return (
    <div className={`${styles.summary} ${styles[VERDICT_TONE[verdict.outcome]]}`} role="status">
      <strong>{`${VERDICT_WORD[verdict.outcome]}: ${title}`}</strong>
      <ul>{verdict.lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}
