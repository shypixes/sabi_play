import {
  MESSAGE_CHANNEL,
  PROTOCOL_VERSION,
  SDK_VERSION,
  isOnChannel,
  isRuntimeCompatible,
  parseGameMessage,
  type GameConfig,
  type GameMessage,
  type GamePlatformApi,
  type HostMessage,
  type InboundMessage,
  type OfficialTimingInfo,
  type RejectionReason,
  type SessionContext,
  type SessionView,
  type SubmitOutcome,
  type TerminationReason,
} from "@/game-sdk";
import { SUBMISSION_GRACE_SECONDS } from "@/lib/competitions/lifecycle";
import { PlatformApiError } from "./platform-api";

/**
 * Platform-side game host. Owns everything privileged: it creates, starts and cancels the
 * session through the existing competition API (the user's own cookie session), and relays a
 * game's result to the existing result endpoint. The game can only ask for what the protocol
 * allows (ready, submit, error, exit) and only in the right phase; it can never start or cancel
 * a session, change timing, or address another session. The backend still authorises every
 * request independently (RLS + SECURITY DEFINER functions); this is defence in depth.
 */

export type HostPhase =
  | "idle"          // nothing created yet
  | "creating"      // creating the practice session
  | "loading"       // session READY; game frame loading (waiting for hello)
  | "awaiting_ready" // context sent; game loading assets
  | "ready"         // game ready; waiting for the player to start
  | "starting"      // start request in flight
  | "playing"
  | "paused"        // page hidden; the official clock keeps running
  | "submitting"    // result being delivered (with safe retries)
  | "completed"     // backend confirmed the result
  | "rejected"      // backend refused the result
  | "unresolved"    // could not confirm; can be re-checked
  | "failed"        // game/session error; nothing more to do but exit
  | "closed";       // exited or disposed

export type HostState = {
  readonly phase: HostPhase;
  readonly session: SessionView | null;
  readonly timing: OfficialTimingInfo | null;
  readonly outcome: SubmitOutcome | null;
  /** User-facing explanation for the current phase (safe to display). */
  readonly message: string | null;
  readonly violations: number;
};

export type LaunchInfo = {
  gameId: string;
  gameVersion: string;
  configId: string;
  timeLimitSeconds: number;
  gameConfig: GameConfig;
};

/** The game frame: where to post and how to recognise its messages. */
export interface FrameChannel {
  post(message: HostMessage): void;
  /** True only for messages whose source is this frame's window (and the sandbox origin). */
  isFromGame(message: InboundMessage): boolean;
}

type HostApi = Pick<GamePlatformApi, "createSession" | "getSession" | "startSession" | "submitResult" | "cancelSession">;

export type HostOptions = {
  api: HostApi;
  launch: LaunchInfo;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Total result-delivery attempts (each followed by reconciliation on ambiguity). */
  submitAttempts?: number;
  retryBaseDelayMs?: number;
  /** The game must say hello and become ready within this time. */
  readyTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** After this many invalid messages the game is stopped. */
export const MAX_PROTOCOL_VIOLATIONS = 10;

const OPEN_STATUSES = new Set(["WAITING", "READY", "IN_PROGRESS"]);

type Reconciled =
  | { kind: "final"; outcome: SubmitOutcome; session: SessionView | null }
  | { kind: "open"; session: SessionView }
  | { kind: "unknown" };

export class GameHostController {
  private state: HostState = { phase: "idle", session: null, timing: null, outcome: null, message: null, violations: 0 };
  private readonly listeners = new Set<() => void>();
  private frame: FrameChannel | null = null;
  private helloSeen = false;
  private submission: { id: string; score: number } | null = null;
  private readyTimer: unknown = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: HostOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ---- observation -------------------------------------------------------------------

  getState = (): HostState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<HostState>) {
    if (this.disposed && patch.phase !== "closed") return;
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // ---- frame wiring ------------------------------------------------------------------

  attachFrame(frame: FrameChannel | null): void {
    this.frame = frame;
  }

  private post<T extends HostMessage["type"]>(type: T, payload: Extract<HostMessage, { type: T }>["payload"]): void {
    const session = this.state.session;
    if (!this.frame || !session || this.disposed) return;
    this.frame.post({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type, sessionId: session.sessionId, payload } as HostMessage);
  }

  private violation(code: string, message: string): void {
    const violations = this.state.violations + 1;
    this.set({ violations });
    this.post("error", { code, message: message.slice(0, 200) });
    if (violations >= MAX_PROTOCOL_VIOLATIONS && !this.isFinal()) {
      this.terminate("protocol_error", "The game sent too many invalid messages and was stopped.");
    }
  }

  private isFinal(): boolean {
    return ["completed", "rejected", "unresolved", "failed", "closed"].includes(this.state.phase);
  }

  private terminate(reason: TerminationReason, message: string): void {
    this.post("terminate", { reason, status: this.state.session?.status ?? null, message });
    this.clearReadyTimer();
    this.set({ phase: "failed", message });
    // Release a session that never started (READY -> CANCELLED). A started session is left for
    // the player to end explicitly (Exit -> ABANDONED) or to expire on the server.
    if (this.state.session?.status === "READY") void this.cancelQuietly();
  }

  // ---- inbound game messages ---------------------------------------------------------

  /** Feed every window "message" event here; anything not from our frame is ignored. */
  receive(event: InboundMessage): void {
    if (this.disposed || !this.frame || !this.frame.isFromGame(event)) return;
    const msg = parseGameMessage(event.data);
    if (!msg) {
      this.violation(isOnChannel(event.data) ? "MALFORMED_MESSAGE" : "UNKNOWN_MESSAGE", "Message rejected: invalid shape, size or channel.");
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.violation("PROTOCOL_MISMATCH", `Protocol ${msg.protocol} is not supported (expected ${PROTOCOL_VERSION}).`);
      return;
    }
    if (msg.type === "hello") {
      this.onHello(msg);
      return;
    }
    const session = this.state.session;
    if (!session || msg.sessionId !== session.sessionId) {
      this.violation("WRONG_SESSION", "Message does not belong to this session.");
      return;
    }
    switch (msg.type) {
      case "ready": return this.onReady();
      case "submit": return void this.onSubmit(msg.payload);
      case "error": return this.onGameError(msg.payload);
      case "exit": return this.onGameExit();
    }
  }

  private onHello(msg: Extract<GameMessage, { type: "hello" }>): void {
    if (this.helloSeen) {
      // The game reloaded or restarted. A session is a single attempt: never re-initialise it.
      this.terminate("restarted", "The game restarted. A practice session can't be restarted; exit and start a new one.");
      return;
    }
    if (this.state.phase !== "loading") {
      this.violation("UNEXPECTED_MESSAGE", "hello is only accepted while the game is loading.");
      return;
    }
    this.helloSeen = true;
    const { launch } = this.opts;
    if (msg.payload.gameId !== launch.gameId || msg.payload.gameVersion !== launch.gameVersion) {
      this.terminate("host_error", `Wrong game: expected ${launch.gameId} ${launch.gameVersion}.`);
      return;
    }
    if (!isRuntimeCompatible({ protocol: msg.protocol, sdkVersion: msg.payload.sdkVersion }, { protocol: PROTOCOL_VERSION, sdkVersion: SDK_VERSION })) {
      this.terminate("host_error", `The game uses SDK ${msg.payload.sdkVersion}, which this platform (SDK ${SDK_VERSION}) does not support.`);
      return;
    }
    this.post("init", { context: this.context() });
    this.set({ phase: "awaiting_ready", message: "Loading the game…" });
  }

  private context(): SessionContext {
    const s = this.state.session;
    if (!s) throw new Error("no session");
    const { launch } = this.opts;
    return {
      sessionId: s.sessionId,
      gameId: launch.gameId,
      gameVersion: launch.gameVersion,
      format: s.format,
      mode: s.mode,
      status: s.status,
      gameConfig: launch.gameConfig,
      timing: { timeLimitSeconds: launch.timeLimitSeconds, graceSeconds: SUBMISSION_GRACE_SECONDS, startedAt: null, endsAt: null, deadlineAt: null, serverOffsetMs: 0 },
      sdk: { hostVersion: SDK_VERSION, protocol: PROTOCOL_VERSION },
    };
  }

  private onReady(): void {
    if (this.state.phase !== "awaiting_ready") {
      this.violation("UNEXPECTED_MESSAGE", "ready is only accepted once, after the session context.");
      return;
    }
    this.clearReadyTimer();
    this.set({ phase: "ready", message: null });
  }

  private onGameError(p: { code: string; message: string; fatal: boolean }): void {
    if (!p.fatal || this.isFinal()) return;
    this.terminate("host_error", `The game stopped with an error (${p.code}).`);
  }

  private onGameExit(): void {
    if (["completed", "rejected", "unresolved", "failed"].includes(this.state.phase)) {
      this.set({ phase: "closed" });
      return;
    }
    this.violation("UNEXPECTED_MESSAGE", "exit is only accepted after the game has finished; the player can exit with the platform's Exit button.");
  }

  // ---- player actions ----------------------------------------------------------------

  /** Player tapped "Play practice": create a READY session for this game. */
  async createSession(): Promise<void> {
    if (this.state.phase !== "idle") return;
    this.set({ phase: "creating", message: "Creating a practice session…" });
    let session: SessionView;
    try {
      session = await this.opts.api.createSession(this.opts.launch.configId);
    } catch (err) {
      this.set({ phase: "idle", message: messageOf(err, "Could not create a practice session.") });
      return;
    }
    if (this.disposed) return;
    this.set({ session });
    const { launch } = this.opts;
    if (session.gameId !== launch.gameId || session.format !== "SCORE_ATTACK" || session.mode !== "PRACTICE" || session.status !== "READY") {
      this.set({ phase: "failed", message: "The platform returned a session this game cannot play." });
      if (OPEN_STATUSES.has(session.status)) void this.cancelQuietly();
      return;
    }
    this.set({ phase: "loading", message: "Loading the game…" });
    this.readyTimer = this.setTimer(() => {
      if (this.state.phase === "loading" || this.state.phase === "awaiting_ready") {
        this.terminate("host_error", "The game did not load in time. The session was released.");
      }
    }, this.opts.readyTimeoutMs ?? 20_000);
  }

  /** Player tapped Start: the server starts the official clock; only then does the game start. */
  async start(): Promise<void> {
    const session = this.state.session;
    if (this.state.phase !== "ready" || !session) return;
    this.set({ phase: "starting", message: "Starting…" });
    const t0 = this.now();
    let started: SessionView | null = null;
    try {
      started = await this.opts.api.startSession(session.sessionId);
    } catch (err) {
      if (!(err instanceof PlatformApiError) || err.ambiguous) {
        // The start may have been applied even though the answer was lost: ask the server.
        started = await this.opts.api.getSession(session.sessionId).catch(() => null);
      }
      if (!started || started.status === "READY") {
        if (this.disposed) return;
        this.set({ phase: "ready", message: messageOf(err, "Could not start. Try again.") });
        return;
      }
    }
    const t1 = this.now();
    if (this.disposed) return;
    if (started.status !== "IN_PROGRESS" || !started.startedAt || !started.deadlineAt) {
      this.set({ session: started });
      this.terminate("session_ended", `The session can't be played (status ${started.status}).`);
      return;
    }
    const startedAt = Date.parse(started.startedAt);
    // Server clock - device clock, estimated at the midpoint of the start request.
    const offset = clamp(Math.round(startedAt - (t0 + t1) / 2), 86_400_000);
    const timing: OfficialTimingInfo = {
      timeLimitSeconds: this.opts.launch.timeLimitSeconds,
      graceSeconds: SUBMISSION_GRACE_SECONDS,
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + this.opts.launch.timeLimitSeconds * 1000).toISOString(),
      deadlineAt: new Date(Date.parse(started.deadlineAt)).toISOString(),
      serverOffsetMs: offset,
    };
    this.set({ session: started, timing, phase: "playing", message: null });
    this.post("start", { timing });
  }

  /** Page hidden. Presentational only: the official deadline is not extended. */
  pause(): void {
    if (this.state.phase !== "playing") return;
    this.set({ phase: "paused" });
    this.post("pause", { reason: "hidden" });
  }

  /** Page visible again: confirm the session is still in progress on the server, then resume. */
  async resume(): Promise<void> {
    const session = this.state.session;
    if (this.state.phase !== "paused" || !session || !this.state.timing) return;
    const fresh = await this.opts.api.getSession(session.sessionId).catch(() => null);
    if (this.disposed || this.state.phase !== "paused") return;
    if (fresh && fresh.status !== "IN_PROGRESS") {
      this.set({ session: fresh });
      this.terminate("session_ended", `This session has ended (status ${fresh.status}).`);
      return;
    }
    // Server unreachable: resume anyway; the server remains authoritative when the result arrives.
    this.set({ phase: "playing", ...(fresh ? { session: fresh } : {}) });
    this.post("resume", { timing: this.state.timing });
  }

  /** Re-check an unresolved submission (same logical submission: same session and score). */
  async recheck(): Promise<void> {
    if (this.state.phase !== "unresolved" || !this.submission) return;
    await this.deliver(this.submission.id, this.submission.score);
  }

  /**
   * Player chose to exit. An open session the player did not finish is ended through the
   * normal cancel route (READY -> CANCELLED, IN_PROGRESS -> ABANDONED). Never after a result
   * was sent: an unresolved result may have been stored.
   */
  async exit(): Promise<void> {
    if (this.state.phase === "closed") return;
    this.post("terminate", { reason: "exit", status: this.state.session?.status ?? null, message: "The player exited." });
    this.clearReadyTimer();
    if (!this.submission && this.state.session && OPEN_STATUSES.has(this.state.session.status)) await this.cancelQuietly();
    this.set({ phase: "closed" });
  }

  /** Stop everything (component unmount). Late responses are ignored. */
  dispose(): void {
    this.clearReadyTimer();
    this.frame = null;
    this.set({ phase: "closed" });
    this.disposed = true;
    this.listeners.clear();
  }

  // ---- result delivery ---------------------------------------------------------------

  private async onSubmit(p: { submissionId: string; score: number; gameVersion: string }): Promise<void> {
    if (p.gameVersion !== this.opts.launch.gameVersion) {
      this.violation("WRONG_GAME_VERSION", "The result's game version does not match this session.");
      return;
    }
    if (this.submission) {
      if (this.submission.id === p.submissionId && this.submission.score === p.score) {
        // Same logical submission repeated by the game: answer with what we know.
        if (this.state.outcome) this.post("submit-result", { submissionId: p.submissionId, outcome: this.state.outcome });
        return;
      }
      this.post("submit-result", {
        submissionId: p.submissionId,
        outcome: { status: "rejected", reason: "ALREADY_SUBMITTED", message: "A result was already submitted for this session." },
      });
      return;
    }
    if (this.state.phase !== "playing" && this.state.phase !== "paused") {
      this.violation("UNEXPECTED_MESSAGE", "Results are only accepted during gameplay.");
      return;
    }
    this.submission = { id: p.submissionId, score: p.score };
    await this.deliver(p.submissionId, p.score);
  }

  private async deliver(submissionId: string, score: number): Promise<void> {
    const session = this.state.session;
    if (!session) return;
    this.set({ phase: "submitting", message: "Saving your result…" });
    const outcome = await this.resolveSubmission(session.sessionId, score);
    if (this.disposed) return;
    const phase: HostPhase = outcome.status === "completed" || outcome.status === "pending_verification"
      ? "completed" : outcome.status === "rejected" ? "rejected" : "unresolved";
    this.set({ outcome, phase, message: outcome.status === "rejected" || outcome.status === "unresolved" ? outcome.message : null });
    this.post("submit-result", { submissionId, outcome });
  }

  /**
   * Delivers one logical result. The database accepts at most one result per session, so
   * re-sending the same body after an ambiguous failure is safe: if the first attempt was
   * stored, the retry is refused and reconciliation (a fresh read of the session) shows our
   * score. A timeout or lost response is never treated as a rejection.
   */
  private async resolveSubmission(sessionId: string, score: number): Promise<SubmitOutcome> {
    const attempts = Math.max(1, this.opts.submitAttempts ?? 4);
    const base = this.opts.retryBaseDelayMs ?? 1000;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const view = await this.opts.api.submitResult(sessionId, { format: "SCORE_ATTACK", score });
        this.set({ session: view });
        const confirmed = outcomeFromView(view, score);
        if (confirmed) return confirmed;
      } catch (err) {
        if (err instanceof PlatformApiError && !err.ambiguous) {
          const definite = await this.definiteFailure(err, sessionId, score);
          if (definite) return definite;
        }
      }
      if (this.disposed) return unresolved();
      const r = await this.reconcile(sessionId, score);
      if (r.kind === "final") return r.outcome;
      if (attempt < attempts) await this.sleep(base * 2 ** (attempt - 1));
    }
    return unresolved();
  }

  private async definiteFailure(err: PlatformApiError, sessionId: string, score: number): Promise<SubmitOutcome | null> {
    switch (err.status) {
      case 400: return rejected("INVALID_RESULT", "The result was refused as invalid.");
      case 401: return rejected("UNAUTHENTICATED", "You were signed out, so the result could not be saved. Log in and start a new session.");
      case 403: return rejected("NOT_ALLOWED", "You are not allowed to submit this result.");
      case 404: return rejected("INVALID_SESSION", "This session no longer exists for your account.");
      case 409: {
        // Refused by state: find out why from the server (it may be OUR earlier attempt).
        const r = await this.reconcile(sessionId, score);
        if (r.kind === "final") return r.outcome;
        return /time limit/i.test(err.message)
          ? rejected("EXPIRED", "The time limit for this session had passed, so the result was not saved.")
          : rejected("NOT_ALLOWED", "The session no longer accepts results.");
      }
      default: return rejected("NOT_ALLOWED", "The result was refused.");
    }
  }

  private async reconcile(sessionId: string, score: number): Promise<Reconciled> {
    let view: SessionView;
    try {
      view = await this.opts.api.getSession(sessionId);
    } catch (err) {
      if (err instanceof PlatformApiError && !err.ambiguous) {
        if (err.status === 404) return { kind: "final", outcome: rejected("INVALID_SESSION", "This session no longer exists for your account."), session: null };
        if (err.status === 401) return { kind: "final", outcome: rejected("UNAUTHENTICATED", "You were signed out. Log in to see your results."), session: null };
      }
      return { kind: "unknown" };
    }
    this.set({ session: view });
    const confirmed = outcomeFromView(view, score);
    if (confirmed) return { kind: "final", outcome: confirmed, session: view };
    switch (view.status) {
      case "IN_PROGRESS": return { kind: "open", session: view };
      case "COMPLETED":
      case "SUBMITTED":
        return { kind: "final", outcome: rejected("ALREADY_SUBMITTED", "A different result was already recorded for this session."), session: view };
      case "ABANDONED": {
        const deadline = view.deadlineAt ? Date.parse(view.deadlineAt) : null;
        const offset = this.state.timing?.serverOffsetMs ?? 0;
        return deadline !== null && this.now() + offset >= deadline
          ? { kind: "final", outcome: rejected("EXPIRED", "The time limit for this session had passed, so the result was not saved."), session: view }
          : { kind: "final", outcome: rejected("NOT_ALLOWED", "The session was ended before the result arrived."), session: view };
      }
      default:
        return { kind: "final", outcome: rejected("INVALID_SESSION", `The session is ${view.status} and does not accept results.`), session: view };
    }
  }

  // ---- helpers -----------------------------------------------------------------------

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) this.clearTimer(this.readyTimer);
    this.readyTimer = null;
  }

  private async cancelQuietly(): Promise<void> {
    const session = this.state.session;
    if (!session) return;
    try {
      const view = await this.opts.api.cancelSession(session.sessionId);
      if (!this.disposed) this.set({ session: view });
    } catch {
      // Leave it: the server keeps the authoritative state and the deadline still applies.
    }
  }
}

function outcomeFromView(view: SessionView, score: number): SubmitOutcome | null {
  const stored = view.result && view.result.format === "SCORE_ATTACK" ? view.result.score : null;
  if (stored !== score) return null;
  if (view.status === "COMPLETED") {
    return { status: "completed", score, validation: view.validationStatus, settlement: view.settlementStatus, completedAt: view.completedAt };
  }
  if (view.status === "SUBMITTED") return { status: "pending_verification", score };
  return null;
}

const rejected = (reason: RejectionReason, message: string): SubmitOutcome => ({ status: "rejected", reason, message });
const unresolved = (): SubmitOutcome => ({
  status: "unresolved",
  message: "We couldn't confirm whether your result was saved. Check your connection and tap Check again.",
});
const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));

function messageOf(err: unknown, fallback: string): string {
  return err instanceof PlatformApiError && err.kind === "http" && err.status !== null && err.status < 500 ? err.message : fallback;
}
