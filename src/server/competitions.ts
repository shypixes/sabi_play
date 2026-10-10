import "server-only";
import { z } from "zod";
import {
  COMPETITION_MAX_VALUE,
  COMPETITION_MODES,
  GAME_TYPES,
  SESSION_STATUSES,
  SETTLEMENT_STATUSES,
  VALIDATION_STATUSES,
  resultSubmissionSchema,
  type CompetitionOption,
  type SessionView,
} from "@/game-sdk";
import { AppError, queryError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { competitionConfigRowSchema, toCompetitionOption } from "@/lib/competitions/config";
import { requiredParticipants } from "@/lib/competitions/lifecycle";
import { createClient } from "@/lib/supabase/server";
import { isGameFormatAvailable } from "@/games/registry";
import { requireUser } from "@/server/auth";

/**
 * Player competition operations.
 *
 * - Identity comes ONLY from requireUser() (verified Supabase session). No function accepts a
 *   user id, and no RPC call passes one: the database derives it from auth.uid().
 * - Uses the user-scoped client, so RLS applies to every read and all writes go through the
 *   SECURITY DEFINER functions in migration 0004, which validate every transition.
 * - Never touches wallets. Paid sessions are refused by the database (paid_competitions_disabled).
 */

const CONFIG_COLUMNS =
  "id, game_id, format, mode, label, entry_fee, reward_model, fixed_reward, target_score, platform_fee_bps, pool_size, payout_bps, time_limit_seconds, enabled";

const SESSION_COLUMNS =
  "id, config_id, game_id, format, mode, status, validation_status, settlement_status, created_at, started_at, deadline_at, completed_at";

const uuid = z.string().uuid();
const slotSchema = z.union([z.literal(1), z.literal(2)]);

export const createSessionInputSchema = z.object({ configId: uuid }).strict();
/** Bodies of join/start/cancel carry no data; anything else (e.g. a userId) is rejected. */
export const emptyBodySchema = z.object({}).strict();
export const configFilterSchema = z.object({
  gameId: z.string().regex(/^[a-z0-9-]+$/).max(60).optional(),
  format: z.enum(GAME_TYPES).optional(),
}).strict();

const sessionRowSchema = z.object({
  id: uuid,
  config_id: uuid,
  game_id: z.string(),
  format: z.enum(GAME_TYPES),
  mode: z.enum(COMPETITION_MODES),
  status: z.enum(SESSION_STATUSES),
  validation_status: z.enum(VALIDATION_STATUSES),
  settlement_status: z.enum(SETTLEMENT_STATUSES),
  created_at: z.string(),
  started_at: z.string().nullable(),
  deadline_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
const participantRowSchema = z.object({ user_id: uuid, slot: slotSchema });
const resultRowSchema = z.object({
  score: z.number().int().min(0).max(COMPETITION_MAX_VALUE).nullable(),
  winner_user_id: uuid.nullable(),
  is_draw: z.boolean(),
});

/** Stable error codes raised by migration 0004 functions -> user-safe errors. */
const RPC_ERRORS: Record<string, () => AppError> = {
  not_authenticated: () => new AppError("UNAUTHENTICATED", "You need to log in."),
  profile_not_found: () => new AppError("FORBIDDEN", "Your player profile is not set up."),
  config_not_found: () => new AppError("NOT_FOUND", "Competition not found."),
  config_disabled: () => new AppError("CONFLICT", "This competition is not open right now."),
  paid_competitions_disabled: () => new AppError("FORBIDDEN", "Paid competitions are not available yet."),
  too_many_open_sessions: () => new AppError("CONFLICT", "Finish or cancel an open session first."),
  session_not_found: () => new AppError("NOT_FOUND", "Session not found."),
  already_joined: () => new AppError("CONFLICT", "You are already in this session."),
  session_not_joinable: () => new AppError("CONFLICT", "This session cannot be joined."),
  invalid_state: () => new AppError("CONFLICT", "That action is not allowed in the session's current state."),
  invalid_result: () => new AppError("VALIDATION_ERROR", "Invalid result."),
};

export function mapRpcError(operation: string, error: { code?: string; message?: string }): Error {
  const known = error.message ? RPC_ERRORS[error.message] : undefined;
  return known ? known() : queryError(operation, error);
}

type Client = Awaited<ReturnType<typeof createClient>>;

async function callRpc(supabase: Client, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw mapRpcError(fn, error);
  return data;
}

function parseSessionId(sessionId: string): string {
  const parsed = uuid.safeParse(sessionId);
  // Same response as an unknown or foreign session: reveals nothing.
  if (!parsed.success) throw new AppError("NOT_FOUND", "Session not found.");
  return parsed.data;
}

/** Enabled configurations for ACTIVE games that support the format. Paid ones are listed (terms are public). */
export async function listCompetitionOptions(filter: unknown = {}): Promise<CompetitionOption[]> {
  await requireUser();
  const f = configFilterSchema.parse(filter);
  const supabase = await createClient();
  let query = supabase.from("competition_configs").select(CONFIG_COLUMNS).eq("enabled", true);
  if (f.gameId) query = query.eq("game_id", f.gameId);
  if (f.format) query = query.eq("format", f.format);
  const { data, error } = await query.order("entry_fee", { ascending: true }).order("label", { ascending: true });
  if (error) throw queryError("competition_configs select", error);

  const options: CompetitionOption[] = [];
  for (const raw of data ?? []) {
    const row = competitionConfigRowSchema.safeParse(raw);
    if (!row.success) {
      logger.warn("Skipping malformed competition config", { action: "competitions.list" });
      continue;
    }
    if (isGameFormatAvailable(row.data.game_id, row.data.format)) options.push(toCompetitionOption(row.data));
  }
  return options;
}

async function loadSessionView(supabase: Client, sessionId: string, userId: string): Promise<SessionView> {
  const { data, error } = await supabase.from("competition_sessions").select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle();
  if (error) throw queryError("competition_sessions select", error);
  // RLS hides sessions the caller does not participate in.
  if (!data) throw new AppError("NOT_FOUND", "Session not found.");
  const session = sessionRowSchema.parse(data);

  const [participantsRes, resultRes] = await Promise.all([
    supabase.from("competition_participants").select("user_id, slot").eq("session_id", sessionId),
    supabase.from("competition_results").select("score, winner_user_id, is_draw").eq("session_id", sessionId).maybeSingle(),
  ]);
  if (participantsRes.error) throw queryError("competition_participants select", participantsRes.error);
  if (resultRes.error) throw queryError("competition_results select", resultRes.error);

  const participants = z.array(participantRowSchema).parse(participantsRes.data ?? []);
  const me = participants.find((p) => p.user_id === userId);
  // Defence in depth on top of RLS.
  if (!me) throw new AppError("NOT_FOUND", "Session not found.");

  let result: SessionView["result"] = null;
  if (resultRes.data) {
    const r = resultRowSchema.parse(resultRes.data);
    if (session.format === "SCORE_ATTACK" && r.score !== null) {
      result = { format: "SCORE_ATTACK", score: r.score };
    } else if (session.format === "ONE_V_ONE") {
      const winner = participants.find((p) => p.user_id === r.winner_user_id);
      result = { format: "ONE_V_ONE", winnerSlot: r.is_draw || !winner ? null : winner.slot };
    }
  }

  return {
    sessionId: session.id,
    configId: session.config_id,
    gameId: session.game_id,
    format: session.format,
    mode: session.mode,
    status: session.status,
    validationStatus: session.validation_status,
    settlementStatus: session.settlement_status,
    yourSlot: me.slot,
    participantCount: participants.length,
    requiredParticipants: requiredParticipants(session.format),
    createdAt: session.created_at,
    startedAt: session.started_at,
    deadlineAt: session.deadline_at,
    completedAt: session.completed_at,
    result,
  };
}

export async function createSession(input: unknown): Promise<SessionView> {
  const user = await requireUser();
  const { configId } = createSessionInputSchema.parse(input);
  const supabase = await createClient();

  const { data, error } = await supabase.from("competition_configs").select("game_id, format").eq("id", configId).maybeSingle();
  if (error) throw queryError("competition_configs select", error);
  if (!data) throw new AppError("NOT_FOUND", "Competition not found.");
  const config = z.object({ game_id: z.string(), format: z.enum(GAME_TYPES) }).parse(data);
  if (!isGameFormatAvailable(config.game_id, config.format)) {
    throw new AppError("CONFLICT", "This game is not available.");
  }

  const sessionId = uuid.parse(await callRpc(supabase, "competition_create_session", { p_config_id: configId }));
  return loadSessionView(supabase, sessionId, user.id);
}

export async function getSession(sessionId: string): Promise<SessionView> {
  const user = await requireUser();
  const id = parseSessionId(sessionId);
  return loadSessionView(await createClient(), id, user.id);
}

async function runSessionAction(sessionId: string, body: unknown, fn: string): Promise<SessionView> {
  const user = await requireUser();
  emptyBodySchema.parse(body);
  const id = parseSessionId(sessionId);
  const supabase = await createClient();
  await callRpc(supabase, fn, { p_session_id: id });
  return loadSessionView(supabase, id, user.id);
}

/** Join a known ONE_V_ONE session (invite primitive; not matchmaking). */
export const joinSession = (sessionId: string, body: unknown = {}) =>
  runSessionAction(sessionId, body, "competition_join_session");
export const startSession = (sessionId: string, body: unknown = {}) =>
  runSessionAction(sessionId, body, "competition_start_session");
export const cancelSession = (sessionId: string, body: unknown = {}) =>
  runSessionAction(sessionId, body, "competition_cancel_session");

/**
 * Report a result. The stored result is NEVER authoritative: practice results become
 * UNVERIFIED; paid results stay PENDING until a trusted validator decides.
 */
export async function submitResult(sessionId: string, input: unknown): Promise<SessionView> {
  const user = await requireUser();
  const id = parseSessionId(sessionId);
  const submission = resultSubmissionSchema.parse(input);
  const supabase = await createClient();

  const current = await loadSessionView(supabase, id, user.id);
  if (current.format !== submission.format) {
    throw new AppError("VALIDATION_ERROR", "Result does not match the session format.");
  }

  const args: Record<string, unknown> = submission.format === "SCORE_ATTACK"
    ? { p_session_id: id, p_score: submission.score }
    : { p_session_id: id, p_winner_slot: submission.winnerSlot, p_is_draw: submission.winnerSlot === null };
  const outcome = z.enum(["UNVERIFIED", "PENDING", "EXPIRED"]).parse(await callRpc(supabase, "competition_submit_result", args));
  if (outcome === "EXPIRED") {
    throw new AppError("CONFLICT", "The time limit for this session has passed.");
  }
  return loadSessionView(supabase, id, user.id);
}

