import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  MAX_SCORE,
  MESSAGE_CHANNEL,
  PROTOCOL_VERSION,
  isOnChannel,
  isValidScore,
  messageSize,
  parseGameMessage,
  parseHostMessage,
} from "@/game-sdk";

// UNIT: host<->game message validation (no mocks).

const SID = "3f0c6a8e-6b4f-4a51-9a39-1c2b3d4e5f60";
const msg = (type: string, payload: unknown, sessionId: string | null = SID) =>
  ({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type, sessionId, payload });

describe("scores", () => {
  it("accepts only safe non-negative integers within the DB limit", () => {
    for (const ok of [0, 1, 123456, MAX_SCORE]) expect(isValidScore(ok)).toBe(true);
    for (const bad of [-1, 1.5, NaN, Infinity, MAX_SCORE + 1, Number.MAX_SAFE_INTEGER + 2, "10", null, 2 ** 64]) {
      expect(isValidScore(bad)).toBe(false);
    }
    expect(MAX_SCORE).toBe(1_000_000_000_000);
  });
});

describe("game -> host messages", () => {
  it("parses the documented messages", () => {
    expect(parseGameMessage(msg("hello", { sdkVersion: "1.0.0", gameId: "pop-rush", gameVersion: "1.0.0" }, null))?.type).toBe("hello");
    expect(parseGameMessage(msg("ready", {}))?.type).toBe("ready");
    expect(parseGameMessage(msg("submit", { submissionId: SID, score: 10, gameVersion: "1.0.0" }))?.type).toBe("submit");
    expect(parseGameMessage(msg("error", { code: "BOOM", message: "x", fatal: true }))?.type).toBe("error");
    expect(parseGameMessage(msg("exit", {}))?.type).toBe("exit");
  });

  it("rejects host-only, unknown and privileged message types", () => {
    for (const type of ["init", "start", "terminate", "submit-result", "cancel", "settle", "wallet"]) {
      expect(parseGameMessage(msg(type, {}))).toBeNull();
    }
  });

  it("rejects fields a game must not set (verification, settlement, user, deadline)", () => {
    for (const extra of [{ validation: "VALID" }, { settlementStatus: "SETTLED" }, { userId: SID }, { deadlineAt: "2030-01-01T00:00:00Z" }]) {
      expect(parseGameMessage(msg("submit", { submissionId: SID, score: 1, gameVersion: "1.0.0", ...extra }))).toBeNull();
    }
    expect(parseGameMessage({ ...msg("ready", {}), userId: SID })).toBeNull();
  });

  it("rejects bad scores, bad ids and wrong envelopes", () => {
    for (const score of [-1, 0.5, "5", MAX_SCORE + 1, null]) {
      expect(parseGameMessage(msg("submit", { submissionId: SID, score, gameVersion: "1.0.0" }))).toBeNull();
    }
    expect(parseGameMessage(msg("submit", { submissionId: "not-a-uuid", score: 1, gameVersion: "1.0.0" }))).toBeNull();
    expect(parseGameMessage(msg("ready", {}, "not-a-uuid"))).toBeNull();
    expect(parseGameMessage(msg("ready", {}, null))).toBeNull(); // only hello may omit the session
    expect(parseGameMessage(msg("hello", { sdkVersion: "1.0.0", gameId: "g", gameVersion: "1.0.0" }, SID))).toBeNull();
    expect(parseGameMessage({ ...msg("ready", {}), channel: "other" })).toBeNull();
    expect(parseGameMessage({ ...msg("ready", {}), protocol: 0 })).toBeNull();
    expect(parseGameMessage(msg("error", { code: "lower case", message: "x", fatal: false }))).toBeNull();
  });

  it("rejects non-plain and oversized data without throwing", () => {
    for (const raw of [null, undefined, "string", 42, [], new Date()]) expect(parseGameMessage(raw)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseGameMessage(cyclic)).toBeNull();
    const huge = msg("error", { code: "BIG", message: "x".repeat(MAX_MESSAGE_BYTES), fatal: false });
    expect(messageSize(huge)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(parseGameMessage(huge)).toBeNull();
  });

  it("recognises channel membership for diagnostics", () => {
    expect(isOnChannel({ channel: MESSAGE_CHANNEL })).toBe(true);
    expect(isOnChannel({ channel: "x" })).toBe(false);
    expect(isOnChannel("x")).toBe(false);
  });
});

describe("host -> game messages", () => {
  const timing = { timeLimitSeconds: 180, graceSeconds: 30, startedAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-01T00:03:00.000Z", deadlineAt: "2026-01-01T00:03:30.000Z", serverOffsetMs: 12 };

  it("parses start/terminate/submit-result and rejects game-only types", () => {
    expect(parseHostMessage(msg("start", { timing }))?.type).toBe("start");
    expect(parseHostMessage(msg("terminate", { reason: "exit", status: "ABANDONED", message: "bye" }))?.type).toBe("terminate");
    expect(parseHostMessage(msg("submit-result", { submissionId: SID, outcome: { status: "unresolved", message: "?" } }))?.type).toBe("submit-result");
    expect(parseHostMessage(msg("submit", { submissionId: SID, score: 1, gameVersion: "1.0.0" }))).toBeNull();
  });

  it("the session context carries no user, wallet or other-player data", () => {
    const context = {
      sessionId: SID, gameId: "pop-rush", gameVersion: "1.0.0", format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY",
      gameConfig: {}, timing: { ...timing, startedAt: null, endsAt: null, deadlineAt: null },
      sdk: { hostVersion: "1.0.0", protocol: 1 },
    };
    expect(parseHostMessage(msg("init", { context }))?.type).toBe("init");
    for (const extra of [{ userId: SID }, { balance: 5 }, { opponents: [] }, { accessToken: "x" }]) {
      expect(parseHostMessage(msg("init", { context: { ...context, ...extra } }))).toBeNull();
    }
  });
});
