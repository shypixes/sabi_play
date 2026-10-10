import { describe, expect, it } from "vitest";
import { GAME_TYPE_RULES, SESSION_STATUSES, resultSubmissionSchema } from "@/game-sdk";
import {
  SESSION_TRANSITIONS,
  afterResultSubmitted,
  canTransition,
  initialSettlementStatus,
  initialStatus,
  isTerminal,
  requiredParticipants,
} from "@/lib/competitions/lifecycle";

// UNIT: lifecycle rules. The DB transition table is asserted identical in tests/db.

describe("session lifecycle", () => {
  it("starts SCORE_ATTACK as READY and ONE_V_ONE as WAITING", () => {
    expect(initialStatus("SCORE_ATTACK")).toBe("READY");
    expect(initialStatus("ONE_V_ONE")).toBe("WAITING");
  });

  it("requires exactly the platform player count per format", () => {
    expect(requiredParticipants("SCORE_ATTACK")).toBe(GAME_TYPE_RULES.SCORE_ATTACK.maxPlayers);
    expect(requiredParticipants("SCORE_ATTACK")).toBe(1);
    expect(requiredParticipants("ONE_V_ONE")).toBe(2);
  });

  it("allows the documented happy paths", () => {
    expect(canTransition("WAITING", "READY")).toBe(true);
    expect(canTransition("READY", "IN_PROGRESS")).toBe(true);
    expect(canTransition("IN_PROGRESS", "COMPLETED")).toBe(true); // practice
    expect(canTransition("IN_PROGRESS", "SUBMITTED")).toBe(true); // paid
    expect(canTransition("SUBMITTED", "COMPLETED")).toBe(true);
  });

  it("rejects skipping, reversing and leaving terminal states", () => {
    expect(canTransition("WAITING", "IN_PROGRESS")).toBe(false);
    expect(canTransition("READY", "COMPLETED")).toBe(false);
    expect(canTransition("IN_PROGRESS", "READY")).toBe(false);
    expect(canTransition("SUBMITTED", "CANCELLED")).toBe(false); // a submitted result cannot be cancelled away
    for (const terminal of ["COMPLETED", "CANCELLED", "ABANDONED"] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of SESSION_STATUSES) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it("defines transitions for every status", () => {
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it("never marks a client-submitted result as trusted", () => {
    expect(afterResultSubmitted("PRACTICE")).toEqual({ status: "COMPLETED", validationStatus: "UNVERIFIED" });
    expect(afterResultSubmitted("PAID")).toEqual({ status: "SUBMITTED", validationStatus: "PENDING" });
  });

  it("tracks settlement only for paid sessions", () => {
    expect(initialSettlementStatus("PRACTICE")).toBe("NOT_REQUIRED");
    expect(initialSettlementStatus("PAID")).toBe("PENDING");
  });
});

describe("result submission schema", () => {
  const ok = (v: unknown) => resultSubmissionSchema.safeParse(v).success;

  it("accepts integer scores in range and well-defined 1v1 outcomes", () => {
    expect(ok({ format: "SCORE_ATTACK", score: 0 })).toBe(true);
    expect(ok({ format: "SCORE_ATTACK", score: 1_000_000_000_000 })).toBe(true);
    expect(ok({ format: "ONE_V_ONE", winnerSlot: 1 })).toBe(true);
    expect(ok({ format: "ONE_V_ONE", winnerSlot: null })).toBe(true); // draw
  });

  it("rejects invalid scores and outcomes", () => {
    for (const score of [-1, 1.5, 1_000_000_000_001, Number.NaN, "100", null]) {
      expect(ok({ format: "SCORE_ATTACK", score })).toBe(false);
    }
    expect(ok({ format: "ONE_V_ONE", winnerSlot: 3 })).toBe(false);
    expect(ok({ format: "ONE_V_ONE" })).toBe(false);
    expect(ok({ format: "SCORE_ATTACK", winnerSlot: 1 })).toBe(false);
  });

  it("rejects extra fields such as a client-claimed identity or verification flag", () => {
    expect(ok({ format: "SCORE_ATTACK", score: 10, userId: "x" })).toBe(false);
    expect(ok({ format: "SCORE_ATTACK", score: 10, verified: true })).toBe(false);
  });
});
