import { z } from "zod";
import {
  COMPETITION_MAX_VALUE,
  COMPETITION_MODES,
  SESSION_STATUSES,
  SETTLEMENT_STATUSES,
  VALIDATION_STATUSES,
} from "./competition";
import { gameConfigSchema } from "./manifest";
import { GAME_TYPES } from "./types";
import { SEMVER_PATTERN } from "./version";

/**
 * Host <-> game message contract (protocol version 1).
 *
 * The game runs in a sandboxed iframe with an opaque origin and no network access. Its only
 * channel to the platform is window.postMessage with the messages below. Every message is
 * validated on receipt (size, schema, sender, session association, current lifecycle phase);
 * anything else is dropped. Messages never carry credentials, user identifiers or wallet data.
 */

export const MESSAGE_CHANNEL = "sabi-play.game";
/** Upper bound for one serialized message, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 4096;
/** Largest score the platform stores (DB CHECK); also within Number.MAX_SAFE_INTEGER. */
export const MAX_SCORE = Math.min(COMPETITION_MAX_VALUE, Number.MAX_SAFE_INTEGER);

export function isValidScore(score: unknown): score is number {
  return typeof score === "number" && Number.isSafeInteger(score) && score >= 0 && score <= MAX_SCORE;
}

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const semver = z.string().regex(SEMVER_PATTERN);
const shortText = z.string().max(200);

/**
 * Official timing, computed from the backend's session timestamps. `serverOffsetMs` is the
 * estimated (server clock - device clock), so the game can show time based on the server.
 *   endsAt     = startedAt + timeLimitSeconds (gameplay ends)
 *   deadlineAt = the backend's deadline (endsAt + grace); results after it are refused
 */
export const officialTimingSchema = z.object({
  timeLimitSeconds: z.number().int().positive().max(3600),
  graceSeconds: z.number().int().min(0).max(300),
  startedAt: iso.nullable(),
  endsAt: iso.nullable(),
  deadlineAt: iso.nullable(),
  serverOffsetMs: z.number().int().min(-86_400_000).max(86_400_000),
}).strict();
export type OfficialTimingInfo = z.infer<typeof officialTimingSchema>;

/** The minimum a game needs. No user id, email, wallet or other players' data. */
export const sessionContextSchema = z.object({
  sessionId: uuid,
  gameId: z.string().max(60),
  gameVersion: semver,
  format: z.enum(GAME_TYPES),
  mode: z.enum(COMPETITION_MODES),
  status: z.enum(SESSION_STATUSES),
  gameConfig: gameConfigSchema,
  timing: officialTimingSchema,
  sdk: z.object({ hostVersion: semver, protocol: z.number().int().positive() }).strict(),
}).strict();
export type SessionContext = z.infer<typeof sessionContextSchema>;

export const REJECTION_REASONS = [
  "EXPIRED", "ALREADY_SUBMITTED", "INVALID_RESULT", "INVALID_SESSION", "NOT_ALLOWED", "UNAUTHENTICATED",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * Outcome of a result submission, as confirmed by the platform.
 *  completed            - the backend stored the result and completed the session (practice:
 *                         validation UNVERIFIED, settlement NOT_REQUIRED; never a reward)
 *  pending_verification - stored, awaiting a trusted validator (paid; disabled in this version)
 *  rejected             - the backend definitively refused the result (reason + safe message)
 *  unresolved           - the platform could not confirm what happened (e.g. the connection was
 *                         lost). NOT a rejection: the result may or may not have been stored.
 */
export const submitOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    score: z.number().int().min(0).max(MAX_SCORE),
    validation: z.enum(VALIDATION_STATUSES),
    settlement: z.enum(SETTLEMENT_STATUSES),
    completedAt: iso.nullable(),
  }).strict(),
  z.object({ status: z.literal("pending_verification"), score: z.number().int().min(0).max(MAX_SCORE) }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.enum(REJECTION_REASONS), message: shortText }).strict(),
  z.object({ status: z.literal("unresolved"), message: shortText }).strict(),
]);
export type SubmitOutcome = z.infer<typeof submitOutcomeSchema>;

export const TERMINATION_REASONS = ["exit", "session_ended", "restarted", "protocol_error", "host_error"] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

const envelopeOf = <T extends string, P extends z.ZodTypeAny, S extends z.ZodTypeAny>(type: T, payload: P, sessionId: S) =>
  z.object({
    channel: z.literal(MESSAGE_CHANNEL),
    protocol: z.number().int().positive(),
    type: z.literal(type),
    sessionId,
    payload,
  }).strict();
/** Every message after the context carries the session id it belongs to. */
const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) => envelopeOf(type, payload, uuid);

/** Messages the platform host sends to the game. */
export const hostMessageSchema = z.discriminatedUnion("type", [
  envelope("init", z.object({ context: sessionContextSchema }).strict()),
  envelope("start", z.object({ timing: officialTimingSchema }).strict()),
  envelope("pause", z.object({ reason: z.enum(["hidden", "host"]) }).strict()),
  envelope("resume", z.object({ timing: officialTimingSchema }).strict()),
  envelope("terminate", z.object({ reason: z.enum(TERMINATION_REASONS), status: z.enum(SESSION_STATUSES).nullable(), message: shortText }).strict()),
  envelope("submit-result", z.object({ submissionId: uuid, outcome: submitOutcomeSchema }).strict()),
  envelope("error", z.object({ code: z.string().regex(/^[A-Z_]{1,40}$/), message: shortText }).strict()),
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

/** Messages a game sends to the platform host. `hello` precedes the session context. */
export const gameMessageSchema = z.discriminatedUnion("type", [
  envelopeOf("hello", z.object({
    sdkVersion: semver,
    gameId: z.string().max(60),
    gameVersion: semver,
  }).strict(), z.null()),
  envelope("ready", z.object({}).strict()),
  envelope("submit", z.object({
    submissionId: uuid,
    score: z.number().refine(isValidScore, "score must be a safe non-negative integer within the platform limit"),
    gameVersion: semver,
  }).strict()),
  envelope("error", z.object({ code: z.string().regex(/^[A-Z_]{1,40}$/), message: shortText, fatal: z.boolean() }).strict()),
  envelope("exit", z.object({}).strict()),
]);
export type GameMessage = z.infer<typeof gameMessageSchema>;

export type HostMessageType = HostMessage["type"];
export type GameMessageType = GameMessage["type"];

/** UTF-8 size of the JSON form, or null if the value is not plain JSON data. */
export function messageSize(data: unknown): number | null {
  try {
    const json = JSON.stringify(data);
    return json === undefined ? null : new TextEncoder().encode(json).length;
  } catch {
    return null;
  }
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const size = messageSize(data);
  if (size === null || size > MAX_MESSAGE_BYTES) return null;
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** A valid game message, or null (oversized, not JSON data, wrong channel, or wrong shape). */
export const parseGameMessage = (data: unknown): GameMessage | null => parseWith(gameMessageSchema, data);
/** A valid host message, or null. */
export const parseHostMessage = (data: unknown): HostMessage | null => parseWith(hostMessageSchema, data);

/** True for anything that claims to be on our channel (used to tell noise from bad messages). */
export function isOnChannel(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { channel?: unknown }).channel === MESSAGE_CHANNEL;
}
