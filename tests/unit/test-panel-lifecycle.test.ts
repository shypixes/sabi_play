import { describe, expect, it } from "vitest";
import { COMPETITION_MAX_VALUE, SESSION_STATUSES } from "@/game-sdk";
import { canTransition, MAX_OPEN_SESSIONS } from "@/lib/competitions/lifecycle";
import {
  DEADLINE_SKEW_MARGIN_SECONDS,
  OUT_OF_RANGE_SCORE,
  REJECTION_TESTS,
  cancelOutcome,
  completionCheck,
  countsTowardOpenLimit,
  deadlineInfo,
  judgeRejection,
  parseScoreInput,
  sameSessionState,
  submitBlockedReason,
  targetSessionId,
  type RejectionTest,
} from "@/app/(app)/test-panel/panel-lifecycle";
import { UNKNOWN_SESSION_ID, type PanelResult, type SessionSnapshot } from "@/app/(app)/test-panel/panel-requests";

// UNIT: TEMPORARY test panel lifecycle mirrors, rejection-test gating and verdicts.
// The database is authoritative; tests/db checks the real behaviour. Remove with the panel.

const SESSION = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-11T12:00:00Z");
const iso = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString();

function snap(o: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION, status: "READY", validationStatus: "NOT_SUBMITTED", settlementStatus: "NOT_REQUIRED",
    mode: "PRACTICE", format: "SCORE_ATTACK", startedAt: null, deadlineAt: null, completedAt: null,
    resultScore: null, hasResult: false, ...o,
  };
}
function response(status: number, body: unknown): PanelResult {
  return {
    kind: "response", action: "start", method: "POST", url: "/x", requestBody: "{}", durationMs: 1, finishedAt: iso(0),
    httpStatus: status, httpOk: status >= 200 && status < 300, isJson: true, body, bodyText: JSON.stringify(body),
  };
}
const err = (status: number, code: string, message = "That action is not allowed in the session's current state.") =>
  response(status, { ok: false, error: { code, message } });
const test = (id: string): RejectionTest => {
  const t = REJECTION_TESTS.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

describe("mirrors of the database rules", () => {
  it("cancelOutcome matches competition_cancel_session and only uses allowed transitions", () => {
    for (const status of SESSION_STATUSES) {
      const out = cancelOutcome(status);
      const cancellable = ["WAITING", "READY", "IN_PROGRESS"].includes(status);
      expect(out !== null, status).toBe(cancellable);
      if (out) expect(canTransition(status, out), `${status} -> ${out}`).toBe(true);
    }
    expect(cancelOutcome("READY")).toBe("CANCELLED");
    expect(cancelOutcome("IN_PROGRESS")).toBe("ABANDONED");
    expect(cancelOutcome(null)).toBeNull();
  });

  it("countsTowardOpenLimit matches competition_open_session_count (expired in-progress sessions stop counting)", () => {
    expect(countsTowardOpenLimit("WAITING", null, NOW)).toBe(true);
    expect(countsTowardOpenLimit("READY", null, NOW)).toBe(true);
    expect(countsTowardOpenLimit("IN_PROGRESS", iso(10), NOW)).toBe(true);
    expect(countsTowardOpenLimit("IN_PROGRESS", iso(0), NOW)).toBe(false); // deadline_at > now() is strict
    expect(countsTowardOpenLimit("IN_PROGRESS", iso(-1), NOW)).toBe(false);
    for (const s of ["SUBMITTED", "COMPLETED", "CANCELLED", "ABANDONED"]) expect(countsTowardOpenLimit(s, iso(100), NOW)).toBe(false);
    expect(MAX_OPEN_SESSIONS).toBe(3);
  });

  it("deadlineInfo uses the device clock and handles missing or bad values", () => {
    expect(deadlineInfo(iso(90), NOW)).toEqual({ passed: false, secondsLeft: 90 });
    expect(deadlineInfo(iso(-5), NOW)).toEqual({ passed: true, secondsLeft: -5 });
    expect(deadlineInfo(null, NOW)).toBeNull();
    expect(deadlineInfo("not a date", NOW)).toBeNull();
  });
});

describe("score input (the API's own schema)", () => {
  it.each([["0", 0], ["4200", 4200], [" 42 ", 42], ["00012", 12], [String(COMPETITION_MAX_VALUE), COMPETITION_MAX_VALUE]])("accepts %j", (text, score) => {
    expect(parseScoreInput(text)).toEqual({ ok: true, score });
  });
  it.each(["", "  ", "-1", "1.5", "1e3", "abc", "12 34", String(COMPETITION_MAX_VALUE + 1), "99999999999999"])("rejects %j", (text) => {
    expect(parseScoreInput(text).ok).toBe(false);
  });
});

describe("normal Submit is only offered for a running session before its deadline", () => {
  it("explains why it is not offered", () => {
    expect(submitBlockedReason(null, NOW)).toMatch(/Create or select/);
    expect(submitBlockedReason(snap({ status: "READY" }), NOW)).toMatch(/Start the session first/);
    for (const s of ["COMPLETED", "CANCELLED", "ABANDONED"]) expect(submitBlockedReason(snap({ status: s }), NOW)).toMatch(/only accepted while IN_PROGRESS/);
    expect(submitBlockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(-1) }), NOW)).toMatch(/deadline has passed/);
    expect(submitBlockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(60) }), NOW)).toBeNull();
  });
});

describe("rejection tests never send a request the backend would accept", () => {
  /** Model of migration 0004 for one request: does it succeed (move the session forward)? */
  function backendAccepts(t: RejectionTest, s: SessionSnapshot, serverNow: number): boolean {
    const deadlinePassed = s.deadlineAt !== null && serverNow > Date.parse(s.deadlineAt);
    if (t.action === "start") return s.status === "READY";
    if (t.action === "cancel") return cancelOutcome(s.status) !== null;
    if (t.action === "submit") {
      const valid = t.score !== undefined && t.score >= 0 && t.score <= COMPETITION_MAX_VALUE;
      return valid && s.status === "IN_PROGRESS" && !deadlinePassed;
    }
    return false; // refresh only reads
  }

  it("for every status and deadline situation, offered tests are refused (server clock may lag up to the margin)", () => {
    const deadlines = [null, iso(120), iso(-10), iso(-(DEADLINE_SKEW_MARGIN_SECONDS + 1)), iso(-3600)];
    let offered = 0;
    for (const t of REJECTION_TESTS.filter((x) => x.target === "current")) {
      for (const status of SESSION_STATUSES) {
        for (const deadlineAt of deadlines) {
          const s = snap({ status, deadlineAt });
          if (t.blockedReason(s, NOW) !== null) continue;
          offered++;
          // Server clock anywhere between "margin behind" and "ahead" of the device.
          for (const skew of [-DEADLINE_SKEW_MARGIN_SECONDS + 1, 0, 30]) {
            expect(backendAccepts(t, s, NOW + skew * 1000), `${t.id} on ${status} deadline ${deadlineAt} skew ${skew}`).toBe(false);
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(10);
  });

  it("all session tests need a session; unknown-id tests always target the fixed unknown id", () => {
    for (const t of REJECTION_TESTS) {
      if (t.target === "current") {
        expect(t.blockedReason(null, NOW), t.id).not.toBeNull();
        expect(targetSessionId(t, SESSION)).toBe(SESSION);
      } else {
        expect(t.blockedReason(null, NOW)).toBeNull();
        expect(targetSessionId(t, SESSION)).toBe(UNKNOWN_SESSION_ID);
        expect(t.expected).toMatchObject({ httpStatus: 404, code: "NOT_FOUND", after: "none" });
      }
    }
  });

  it("availability matches the intended scenario for each test", () => {
    expect(test("start-not-ready").blockedReason(snap({ status: "READY" }), NOW)).toMatch(/would succeed/);
    expect(test("start-not-ready").blockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(60) }), NOW)).toBeNull();
    expect(test("submit-before-start").blockedReason(snap({ status: "READY" }), NOW)).toBeNull();
    expect(test("submit-finished").blockedReason(snap({ status: "COMPLETED", hasResult: true, resultScore: 5 }), NOW)).toBeNull();
    expect(test("submit-finished").blockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(60) }), NOW)).not.toBeNull();
    expect(test("cancel-finished").blockedReason(snap({ status: "CANCELLED" }), NOW)).toBeNull();
    expect(test("cancel-finished").blockedReason(snap({ status: "READY" }), NOW)).not.toBeNull();
    const late = test("submit-after-deadline");
    expect(late.blockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(-30) }), NOW)).toMatch(/at least 60s/);
    expect(late.blockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(-61) }), NOW)).toBeNull();
    expect(test("submit-invalid-score").score).toBe(OUT_OF_RANGE_SCORE);
    expect(OUT_OF_RANGE_SCORE).toBe(COMPETITION_MAX_VALUE + 1);
    expect(test("submit-invalid-score").blockedReason(snap({ status: "IN_PROGRESS", deadlineAt: iso(60) }), NOW)).toBeNull();
  });
});

describe("verdicts are computed from the real response and session state", () => {
  const before = snap({ status: "IN_PROGRESS", startedAt: iso(-10), deadlineAt: iso(200) });

  it("PASS: refused with the expected status and the session is unchanged", () => {
    const v = judgeRejection(test("start-not-ready"), err(409, "CONFLICT"), before, { ...before });
    expect(v.outcome).toBe("pass");
    expect(v.lines.join(" ")).toMatch(/Rejected as expected: HTTP 409 CONFLICT.*Session unchanged/);
  });

  it("FAIL: the request succeeded", () => {
    expect(judgeRejection(test("start-not-ready"), response(200, { ok: true, data: { session: {} } }), before, before).outcome).toBe("fail");
  });

  it("FAIL: refused, but the session changed anyway", () => {
    const v = judgeRejection(test("cancel-finished"), err(409, "CONFLICT"), before, { ...before, status: "ABANDONED" });
    expect(v.outcome).toBe("fail");
    expect(v.lines.join(" ")).toMatch(/Session CHANGED: IN_PROGRESS -> ABANDONED \(changed: status/);
  });

  it("FAIL: wrong status code or wrong message where a specific one is expected", () => {
    expect(judgeRejection(test("submit-invalid-score"), err(409, "CONFLICT"), before, before).outcome).toBe("fail");
    const late = test("submit-after-deadline");
    expect(judgeRejection(late, err(409, "CONFLICT"), before, { ...before, status: "ABANDONED", completedAt: iso(0) }).outcome).toBe("fail");
  });

  it("late submission: PASS only when refused with 'time limit' AND the session became ABANDONED without a result", () => {
    const late = test("submit-after-deadline");
    const timeLimit = err(409, "CONFLICT", "The time limit for this session has passed.");
    expect(judgeRejection(late, timeLimit, before, { ...before, status: "ABANDONED", completedAt: iso(0) }).outcome).toBe("pass");
    expect(judgeRejection(late, timeLimit, before, { ...before }).outcome).toBe("fail");
    expect(judgeRejection(late, timeLimit, before, { ...before, status: "ABANDONED", hasResult: true, resultScore: 1 }).outcome).toBe("fail");
  });

  it("INCONCLUSIVE: no response, or the session could not be compared", () => {
    const network: PanelResult = { kind: "network-error", action: "start", method: "POST", url: "/x", requestBody: "{}", durationMs: 0, finishedAt: iso(0), message: "Load failed" };
    expect(judgeRejection(test("start-not-ready"), network, before, before).outcome).toBe("inconclusive");
    expect(judgeRejection(test("start-not-ready"), err(409, "CONFLICT"), before, null).outcome).toBe("inconclusive");
  });

  it("unknown-id tests only need the 404", () => {
    expect(judgeRejection(test("read-unknown"), err(404, "NOT_FOUND", "Session not found."), null, null).outcome).toBe("pass");
    expect(judgeRejection(test("cancel-unknown"), err(409, "CONFLICT"), null, null).outcome).toBe("fail");
  });

  it("a change that keeps the status names the changed field", () => {
    const v = judgeRejection(test("cancel-finished"), err(409, "CONFLICT"), snap({ status: "COMPLETED", completedAt: iso(0) }), snap({ status: "COMPLETED", completedAt: iso(1) }));
    expect(v.outcome).toBe("fail");
    expect(v.lines).toContain("Session CHANGED: COMPLETED -> COMPLETED (changed: completedAt).");
  });

  it("sameSessionState compares every observable field", () => {
    expect(sameSessionState(before, { ...before })).toBe(true);
    for (const change of [{ status: "ABANDONED" }, { completedAt: iso(1) }, { resultScore: 1, hasResult: true }, { hasResult: true }, { validationStatus: "UNVERIFIED" }, { settlementStatus: "COMPLETED" }, { deadlineAt: iso(1) }]) {
      expect(sameSessionState(before, { ...before, ...change }), JSON.stringify(change)).toBe(false);
    }
  });
});

describe("completion check after an accepted submission", () => {
  const completed = snap({ status: "COMPLETED", validationStatus: "UNVERIFIED", completedAt: iso(0), startedAt: iso(-60), deadlineAt: iso(150), hasResult: true, resultScore: 4200 });

  it("PASS only for COMPLETED + completion time + exact score + UNVERIFIED + NOT_REQUIRED", () => {
    expect(completionCheck(4200, completed)).toMatchObject({ outcome: "pass" });
    expect(completionCheck(4200, completed).lines).toContain("✓ Validation UNVERIFIED (stored, never verified for practice)");
  });
  it.each([
    [{ status: "IN_PROGRESS", completedAt: null }, /Status is IN_PROGRESS/],
    [{ resultScore: 4199 }, /Stored score is 4199, expected 4200/],
    [{ hasResult: false, resultScore: null }, /Stored score is missing/],
    [{ validationStatus: "VERIFIED" }, /Validation is VERIFIED/],
    [{ settlementStatus: "COMPLETED" }, /Settlement is COMPLETED/],
  ])("FAIL when %j", (change, line) => {
    const v = completionCheck(4200, { ...completed, ...change });
    expect(v.outcome).toBe("fail");
    expect(v.lines.join(" ")).toMatch(line);
  });
  it("INCONCLUSIVE when the session could not be reloaded", () => {
    expect(completionCheck(4200, null).outcome).toBe("inconclusive");
  });
});
