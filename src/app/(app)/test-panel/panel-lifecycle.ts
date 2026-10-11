/**
 * TEMPORARY competition test panel: lifecycle rules used for UI hints (client-safe, pure).
 * Remove with the whole src/app/(app)/test-panel folder before launch.
 *
 * The DATABASE is authoritative (migration 0004: competition_start_session,
 * competition_submit_result, competition_cancel_session, competition_open_session_count).
 * These mirrors only decide which buttons to offer and what to expect; the panel always
 * shows the server's real answer, and the tests check the mirrors against the migration.
 */
import { resultSubmissionSchema } from "@/game-sdk";
import { MAX_OPEN_SESSIONS, SUBMISSION_GRACE_SECONDS } from "@/lib/competitions/lifecycle";
import { UNKNOWN_SESSION_ID, type PanelAction, type PanelResult, type SessionSnapshot } from "./panel-requests";

export { MAX_OPEN_SESSIONS, SUBMISSION_GRACE_SECONDS };

/** Statuses that can never change again. */
export const FINISHED_STATUSES = ["COMPLETED", "CANCELLED", "ABANDONED"] as const;
export const isFinished = (status: string | null | undefined): boolean =>
  (FINISHED_STATUSES as readonly string[]).includes(status ?? "");

/** competition_cancel_session: WAITING/READY -> CANCELLED, IN_PROGRESS -> ABANDONED, otherwise refused. */
export function cancelOutcome(status: string | null | undefined): "CANCELLED" | "ABANDONED" | null {
  if (status === "WAITING" || status === "READY") return "CANCELLED";
  if (status === "IN_PROGRESS") return "ABANDONED";
  return null;
}

export type DeadlineInfo = { passed: boolean; secondsLeft: number };

/** Time left until deadline_at by THIS DEVICE's clock (the server uses its own clock). */
export function deadlineInfo(deadlineAt: string | null | undefined, nowMs: number): DeadlineInfo | null {
  if (!deadlineAt) return null;
  const t = Date.parse(deadlineAt);
  if (Number.isNaN(t)) return null;
  const secondsLeft = Math.floor((t - nowMs) / 1000);
  return { passed: t <= nowMs, secondsLeft };
}

/** competition_open_session_count: WAITING/READY, or IN_PROGRESS whose deadline has not passed. */
export function countsTowardOpenLimit(status: string, deadlineAt: string | null, nowMs: number): boolean {
  if (status === "WAITING" || status === "READY") return true;
  if (status !== "IN_PROGRESS") return false;
  const d = deadlineInfo(deadlineAt, nowMs);
  return d !== null && !d.passed;
}

export type ScoreInput = { ok: true; score: number } | { ok: false; message: string };

/** Whole number in the range the API accepts (validated with the API's own schema). */
export function parseScoreInput(text: string): ScoreInput {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter a score." };
  if (!/^\d{1,13}$/.test(t)) return { ok: false, message: "Use digits only: a whole number from 0 to 1,000,000,000,000." };
  const score = Number(t);
  const parsed = resultSubmissionSchema.safeParse({ format: "SCORE_ATTACK", score });
  if (!parsed.success) return { ok: false, message: "The score must be from 0 to 1,000,000,000,000." };
  return { ok: true, score };
}

/** Why the normal Submit control is not offered for this session (null = offered). */
export function submitBlockedReason(s: SessionSnapshot | null, nowMs: number): string | null {
  if (!s) return "Create or select a session first.";
  if (s.status !== "IN_PROGRESS") {
    return s.status === "READY"
      ? "Start the session first (results are only accepted while IN_PROGRESS)."
      : `Results are only accepted while IN_PROGRESS; this session is ${s.status}.`;
  }
  if (deadlineInfo(s.deadlineAt, nowMs)?.passed) {
    return "The deadline has passed (by this device's clock). Use the rejection test \"Submit after the deadline\" to check the backend's handling.";
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Rejection tests: send a real request that the backend is expected to REFUSE.
// Each one is only sent when a fresh GET of the session predicts a refusal, so these
// buttons cannot accidentally move a session forward. Nothing here creates a session.
// ---------------------------------------------------------------------------------------

/** Submitting this long after the device-clock deadline tolerates clock differences with the server. */
export const DEADLINE_SKEW_MARGIN_SECONDS = 60;

/** One above the maximum the API accepts (COMPETITION_MAX_VALUE). */
export const OUT_OF_RANGE_SCORE = 1_000_000_000_001;

export type AfterExpectation =
  | "unchanged"             // session must be identical before and after
  | "abandoned-no-result"   // backend marks ABANDONED and stores no result (late submission)
  | "none";                 // no session involved (unknown id)

export type RejectionTest = {
  id: string;
  label: string;
  description: string;
  action: PanelAction;
  target: "current" | "unknown";
  score?: number;
  expected: { httpStatus: number; code: string; message?: RegExp; after: AfterExpectation };
  /** null when the test may be sent for this freshly loaded session; otherwise why not. */
  blockedReason: (s: SessionSnapshot | null, nowMs: number) => string | null;
};

const needSession = (s: SessionSnapshot | null) => (s ? null : "Create or select a session first.");

export const REJECTION_TESTS: readonly RejectionTest[] = [
  {
    id: "start-not-ready",
    label: "Start a session that is not READY",
    description: "POST .../start on an IN_PROGRESS or finished session. Expect 409; session unchanged.",
    action: "start", target: "current",
    expected: { httpStatus: 409, code: "CONFLICT", after: "unchanged" },
    blockedReason: (s) => needSession(s) ?? (s?.status === "READY" ? "This session is READY, so Start would succeed. Use the Start button instead." : null),
  },
  {
    id: "submit-before-start",
    label: "Submit a result before starting",
    description: "POST .../result (score 0) on a READY session. Expect 409; session unchanged, no result stored.",
    action: "submit", target: "current", score: 0,
    expected: { httpStatus: 409, code: "CONFLICT", after: "unchanged" },
    blockedReason: (s) => needSession(s) ?? (s?.status === "READY" ? null : "Only for a READY (not yet started) session."),
  },
  {
    id: "submit-finished",
    label: "Submit again / to a finished session",
    description: "POST .../result (score 1) on a COMPLETED, CANCELLED or ABANDONED session. Expect 409; the stored result (if any) is unchanged and no duplicate is created.",
    action: "submit", target: "current", score: 1,
    expected: { httpStatus: 409, code: "CONFLICT", after: "unchanged" },
    blockedReason: (s) => needSession(s) ?? (isFinished(s?.status) ? null : "Only for a finished session (e.g. after a result was accepted)."),
  },
  {
    id: "submit-after-deadline",
    label: "Submit after the deadline",
    description: `POST .../result (score 1) on an IN_PROGRESS session whose deadline passed at least ${DEADLINE_SKEW_MARGIN_SECONDS}s ago. Expect 409 "time limit"; the backend marks the session ABANDONED and stores no result.`,
    action: "submit", target: "current", score: 1,
    expected: { httpStatus: 409, code: "CONFLICT", message: /time limit/i, after: "abandoned-no-result" },
    blockedReason: (s, nowMs) => {
      const missing = needSession(s);
      if (missing || !s) return missing;
      if (s.status !== "IN_PROGRESS") return "Only for an IN_PROGRESS session.";
      const d = deadlineInfo(s.deadlineAt, nowMs);
      if (!d || d.secondsLeft > -DEADLINE_SKEW_MARGIN_SECONDS) {
        return `Wait until the deadline is at least ${DEADLINE_SKEW_MARGIN_SECONDS}s in the past (by this device's clock), so the server's clock has also passed it.`;
      }
      return null;
    },
  },
  {
    id: "cancel-finished",
    label: "Cancel a finished session (repeat cancellation)",
    description: "POST .../cancel on a COMPLETED, CANCELLED or ABANDONED session. Expect 409; session unchanged.",
    action: "cancel", target: "current",
    expected: { httpStatus: 409, code: "CONFLICT", after: "unchanged" },
    blockedReason: (s) => needSession(s) ?? (isFinished(s?.status) ? null : "Only for a finished session. (Cancelling an open session would succeed.)"),
  },
  {
    id: "submit-invalid-score",
    label: "Submit an out-of-range score",
    description: `POST .../result with score ${OUT_OF_RANGE_SCORE.toLocaleString("en-US")}. Expect 400 (rejected before the database); session unchanged.`,
    action: "submit", target: "current", score: OUT_OF_RANGE_SCORE,
    expected: { httpStatus: 400, code: "VALIDATION_ERROR", after: "unchanged" },
    blockedReason: (s) => needSession(s),
  },
  {
    id: "read-unknown",
    label: "Read a session that is not yours",
    description: "GET a well-formed session id that does not exist. The API answers other players' sessions the same way. Expect 404.",
    action: "refresh", target: "unknown",
    expected: { httpStatus: 404, code: "NOT_FOUND", after: "none" },
    blockedReason: () => null,
  },
  {
    id: "cancel-unknown",
    label: "Cancel a session that is not yours",
    description: "POST .../cancel for a session id that does not belong to you. Expect 404; nothing changes.",
    action: "cancel", target: "unknown",
    expected: { httpStatus: 404, code: "NOT_FOUND", after: "none" },
    blockedReason: () => null,
  },
];

export const targetSessionId = (test: RejectionTest, current: string | null): string | null =>
  test.target === "unknown" ? UNKNOWN_SESSION_ID : current;

/** Every field the panel can observe must be identical. */
const COMPARED_FIELDS = [
  "sessionId", "status", "validationStatus", "settlementStatus", "startedAt", "deadlineAt", "completedAt", "hasResult", "resultScore",
] as const satisfies readonly (keyof SessionSnapshot)[];

/** Names of the observable fields that differ between two reads of a session. */
export function changedFields(a: SessionSnapshot, b: SessionSnapshot): string[] {
  return COMPARED_FIELDS.filter((k) => a[k] !== b[k]);
}

export function sameSessionState(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return changedFields(a, b).length === 0;
}

export type Verdict = { outcome: "pass" | "fail" | "inconclusive"; lines: string[] };

function apiError(result: PanelResult): { code: string; message: string } | null {
  if (result.kind !== "response" || !result.body || typeof result.body !== "object") return null;
  const b = result.body as Record<string, unknown>;
  const e = b.ok === false && b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : null;
  return e && typeof e.code === "string" && typeof e.message === "string" ? { code: e.code, message: e.message } : null;
}

/** Compares the real response (and the session before/after) with the expectation. */
export function judgeRejection(
  test: RejectionTest,
  response: PanelResult,
  before: SessionSnapshot | null,
  after: SessionSnapshot | null,
): Verdict {
  const lines: string[] = [];
  const exp = test.expected;
  if (response.kind !== "response") {
    return { outcome: "inconclusive", lines: ["No response from the server (network error). Nothing can be concluded."] };
  }
  const err = apiError(response);
  const statusOk = response.httpStatus === exp.httpStatus && err?.code === exp.code && (!exp.message || exp.message.test(err.message));
  lines.push(
    statusOk
      ? `Rejected as expected: HTTP ${response.httpStatus} ${err?.code ?? ""}.`
      : `Expected HTTP ${exp.httpStatus} ${exp.code}${exp.message ? ` (${exp.message.source})` : ""}, got HTTP ${response.httpStatus} ${err?.code ?? "(no error envelope)"}.`,
  );

  let afterOk = true;
  let inconclusive = false;
  if (exp.after !== "none") {
    if (!before || !after) {
      inconclusive = true;
      lines.push("Could not load the session before and after, so its state could not be compared.");
    } else if (exp.after === "unchanged") {
      afterOk = sameSessionState(before, after);
      lines.push(afterOk ? `Session unchanged (status ${after.status}, result ${after.hasResult ? after.resultScore : "none"}).` : `Session CHANGED: ${before.status} -> ${after.status} (changed: ${changedFields(before, after).join(", ")}).`);
    } else {
      afterOk = after.status === "ABANDONED" && !after.hasResult;
      lines.push(afterOk
        ? "Backend marked the session ABANDONED and stored no result (late submission handling)."
        : `Expected ABANDONED with no result; got ${after.status}${after.hasResult ? " with a stored result" : ""}.`);
    }
  }
  if (!statusOk || !afterOk) return { outcome: "fail", lines };
  return { outcome: inconclusive ? "inconclusive" : "pass", lines };
}

/**
 * After an accepted submission: does the RELOADED session show a completed practice session
 * with exactly the submitted score? (API acceptance alone is not completion.)
 */
export function completionCheck(submittedScore: number, refreshed: SessionSnapshot | null): Verdict {
  if (!refreshed) {
    return { outcome: "inconclusive", lines: ["The session could not be reloaded after submitting, so completion is NOT confirmed. Tap Refresh session."] };
  }
  const checks: [boolean, string, string][] = [
    [refreshed.status === "COMPLETED", "Status COMPLETED", `Status is ${refreshed.status}, not COMPLETED`],
    [refreshed.completedAt !== null, "Completion time recorded", "No completion time recorded"],
    [refreshed.hasResult && refreshed.resultScore === submittedScore, `Stored score is ${submittedScore}`, `Stored score is ${refreshed.hasResult ? refreshed.resultScore : "missing"}, expected ${submittedScore}`],
    [refreshed.validationStatus === "UNVERIFIED", "Validation UNVERIFIED (stored, never verified for practice)", `Validation is ${refreshed.validationStatus}`],
    [refreshed.settlementStatus === "NOT_REQUIRED", "Settlement NOT_REQUIRED (no payout for practice)", `Settlement is ${refreshed.settlementStatus}`],
  ];
  return {
    outcome: checks.every(([ok]) => ok) ? "pass" : "fail",
    lines: checks.map(([ok, good, bad]) => (ok ? `✓ ${good}` : `✗ ${bad}`)),
  };
}
