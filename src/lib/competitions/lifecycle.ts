import {
  GAME_TYPE_RULES,
  type CompetitionMode,
  type GameType,
  type SessionStatus,
  type SettlementStatus,
  type ValidationStatus,
} from "@/game-sdk";

/**
 * Session lifecycle rules. The database (competition_status_transition_allowed + guard
 * trigger in migration 0004) is authoritative; tests/db asserts this table is identical.
 *
 *   ONE_V_ONE:    WAITING -> READY            (second player joins)
 *   both:         READY -> IN_PROGRESS        (start; deadline = time limit + grace)
 *   PRACTICE:     IN_PROGRESS -> COMPLETED    (result stored as UNVERIFIED)
 *   PAID:         IN_PROGRESS -> SUBMITTED -> COMPLETED (validator: VERIFIED / REJECTED)
 *   cancel/fail:  WAITING|READY -> CANCELLED, IN_PROGRESS -> ABANDONED (quit or deadline passed)
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  WAITING: ["READY", "CANCELLED"],
  READY: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["SUBMITTED", "COMPLETED", "ABANDONED"],
  SUBMITTED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  ABANDONED: [],
};

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["COMPLETED", "CANCELLED", "ABANDONED"];

/** Seconds allowed after the time limit for a result to arrive (network latency). */
export const SUBMISSION_GRACE_SECONDS = 30;

/** Max concurrent WAITING/READY/IN_PROGRESS sessions per player (abuse guard). */
export const MAX_OPEN_SESSIONS = 3;

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function requiredParticipants(format: GameType): number {
  return GAME_TYPE_RULES[format].maxPlayers;
}

export function initialStatus(format: GameType): "READY" | "WAITING" {
  return requiredParticipants(format) === 1 ? "READY" : "WAITING";
}

export function initialSettlementStatus(mode: CompetitionMode): SettlementStatus {
  return mode === "PRACTICE" ? "NOT_REQUIRED" : "PENDING";
}

/** Where a session goes when its result is recorded. Client results are never trusted. */
export function afterResultSubmitted(mode: CompetitionMode): { status: SessionStatus; validationStatus: ValidationStatus } {
  return mode === "PRACTICE"
    ? { status: "COMPLETED", validationStatus: "UNVERIFIED" }
    : { status: "SUBMITTED", validationStatus: "PENDING" };
}
