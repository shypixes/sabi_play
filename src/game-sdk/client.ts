import { checkSdkCompatibility, validateManifest, type GameManifest } from "./manifest";
import {
  MESSAGE_CHANNEL,
  isValidScore,
  parseHostMessage,
  type GameMessage,
  type HostMessage,
  type OfficialTimingInfo,
  type SessionContext,
  type SubmitOutcome,
  type TerminationReason,
} from "./protocol";
import type { SessionStatus } from "./competition";
import { PROTOCOL_VERSION, SDK_VERSION, isRuntimeCompatible } from "./version";

/**
 * Game SDK v1: the ONLY platform interface a game uses. See src/game-sdk/README.md.
 *
 * Lifecycle (enforced): connectToPlatform() [initialise, receive session context, verify
 * compatibility] -> ready() -> "start" (only when the platform has started the session on the
 * server) -> gameplay ("pause"/"resume" are presentational: the official clock keeps running)
 * -> submitResult() or "terminate" -> dispose().
 */

export type GamePhase = "connected" | "ready" | "playing" | "paused" | "submitting" | "finished" | "terminated" | "disposed";

export type SdkErrorCode =
  | "NOT_IN_FRAME"
  | "INVALID_MANIFEST"
  | "INCOMPATIBLE"
  | "WRONG_GAME"
  | "SESSION_NOT_PLAYABLE"
  | "HOST_TIMEOUT"
  | "INVALID_STATE"
  | "INVALID_SCORE"
  | "DUPLICATE_SUBMISSION"
  | "DISPOSED";

/** Thrown (or rejected) only for misuse or an unusable environment, never for a refused result. */
export class SdkError extends Error {
  constructor(readonly code: SdkErrorCode, message: string) {
    super(message);
    this.name = "SdkError";
  }
}

/** Official timing based on the platform's server clock. Times are epoch milliseconds. */
export interface OfficialTiming {
  readonly timeLimitSeconds: number;
  readonly graceSeconds: number;
  /** null until the platform has started the session. */
  readonly startedAt: number | null;
  /** Gameplay end (startedAt + time limit). */
  readonly endsAt: number | null;
  /** Backend deadline for results (endsAt + grace). Results after it are refused by the server. */
  readonly deadlineAt: number | null;
  /** Current time on the server clock (device clock + estimated offset). */
  now(): number;
  /** Gameplay time left, 0 when over, null before start. Unaffected by pausing or backgrounding. */
  remainingMs(): number | null;
}

export type TerminationInfo = { reason: TerminationReason; status: SessionStatus | null; message: string };

export interface GameSdkEvents {
  start: (timing: OfficialTiming) => void;
  pause: () => void;
  resume: (timing: OfficialTiming) => void;
  terminate: (info: TerminationInfo) => void;
  /** Every submission outcome, including a later final answer after an "unresolved" one. */
  result: (outcome: SubmitOutcome) => void;
}

export interface GameSdk {
  /** SDK version the game was built with. */
  readonly version: string;
  /** Session context from the platform (read-only snapshot). */
  readonly context: Readonly<SessionContext>;
  readonly phase: GamePhase;
  /** Signal that assets are loaded and the game can start. Call once, after registering handlers. */
  ready(): void;
  on<E extends keyof GameSdkEvents>(event: E, handler: GameSdkEvents[E]): () => void;
  timing(): OfficialTiming;
  /**
   * Submit the final score once. Resolves with the platform-confirmed outcome (it never rejects
   * because the backend refused or the network failed; see SubmitOutcome). Rejects with SdkError
   * only for misuse: before start, after finishing, invalid score, or a second different result.
   * Calling it again with the same score returns the same promise (idempotent).
   */
  submitResult(result: { score: number }): Promise<SubmitOutcome>;
  /** Report a game error to the platform. `fatal` ends the attempt. */
  reportError(code: string, message: string, options?: { fatal?: boolean }): void;
  /** Ask the platform to close the game (e.g. after showing the result). */
  exit(): void;
  /** Remove every listener and timer. Safe to call more than once. */
  dispose(): void;
}

/** A game module (the manifest `entry`) exports this as `default`; created with defineGame(). */
export interface GameModule {
  mount(root: HTMLElement, sdk: GameSdk): { dispose(): void };
}
export const defineGame = (game: GameModule): GameModule => game;

/** Inbound message as delivered by the environment. */
export type InboundMessage = { data: unknown; origin: string; source: unknown };

/** Platform integration seam (browser by default; replaced in tests). */
export interface SdkEnvironment {
  listen(handler: (message: InboundMessage) => void): () => void;
  /** True only for messages from the platform host window at the platform origin. */
  isFromHost(message: InboundMessage): boolean;
  post(message: GameMessage): void;
  now(): number;
  randomId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type ConnectOptions = {
  /** The game's own manifest (validated again here). */
  manifest: unknown;
  /** How long to wait for the session context. Default 10s. */
  timeoutMs?: number;
  /** How long to wait for a submission answer before reporting "unresolved". Default 60s. */
  submitTimeoutMs?: number;
  env?: SdkEnvironment;
};

function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Browser environment: the game frame is served by the platform, so the host origin is ours. */
export function browserEnvironment(): SdkEnvironment {
  if (typeof window === "undefined" || window.parent === window) {
    throw new SdkError("NOT_IN_FRAME", "The game must be launched by the Sabi Play platform.");
  }
  const hostOrigin = window.location.origin;
  return {
    listen(handler) {
      const fn = (e: MessageEvent) => handler({ data: e.data, origin: e.origin, source: e.source });
      window.addEventListener("message", fn);
      return () => window.removeEventListener("message", fn);
    },
    isFromHost: (m) => m.source === window.parent && m.origin === hostOrigin,
    post: (message) => window.parent.postMessage(message, hostOrigin),
    now: () => Date.now(),
    randomId: randomUuid,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
  };
}

type PayloadOf<T extends GameMessage["type"]> = Extract<GameMessage, { type: T }>["payload"];

function envelope<T extends GameMessage["type"]>(type: T, sessionId: string | null, payload: PayloadOf<T>): GameMessage {
  return { channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type, sessionId, payload } as GameMessage;
}

const ms = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

function toTiming(info: OfficialTimingInfo, env: SdkEnvironment): OfficialTiming {
  const endsAt = ms(info.endsAt);
  const now = () => env.now() + info.serverOffsetMs;
  return Object.freeze({
    timeLimitSeconds: info.timeLimitSeconds,
    graceSeconds: info.graceSeconds,
    startedAt: ms(info.startedAt),
    endsAt,
    deadlineAt: ms(info.deadlineAt),
    now,
    remainingMs: () => (endsAt === null ? null : Math.max(0, endsAt - now())),
  });
}

/**
 * Connects to the platform host: validates the manifest and SDK compatibility, announces the
 * game, waits for the session context and verifies it. Rejects with SdkError on failure (the
 * platform is told, so it can show the error and release the session).
 */
export function connectToPlatform(options: ConnectOptions): Promise<GameSdk> {
  return new Promise<GameSdk>((resolve, reject) => {
    const validation = validateManifest(options.manifest);
    if (!validation.ok) {
      reject(new SdkError("INVALID_MANIFEST", `Invalid game manifest: ${validation.errors.join("; ")}`));
      return;
    }
    const manifest: GameManifest = validation.manifest;
    const incompatible = checkSdkCompatibility(manifest, SDK_VERSION);
    if (incompatible) {
      reject(new SdkError("INCOMPATIBLE", incompatible));
      return;
    }
    let env: SdkEnvironment;
    try {
      env = options.env ?? browserEnvironment();
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const fail = (code: SdkErrorCode, message: string, sessionId: string | null) => {
      if (settled) return;
      settled = true;
      stop();
      env.clearTimer(timer);
      if (sessionId) env.post(envelope("error", sessionId, { code: code === "WRONG_GAME" ? "WRONG_GAME" : code, message: message.slice(0, 200), fatal: true }));
      reject(new SdkError(code, message));
    };

    const stop = env.listen((m) => {
      if (settled || !env.isFromHost(m)) return;
      const msg = parseHostMessage(m.data);
      if (!msg || msg.type !== "init") return;
      const ctx = msg.payload.context;
      if (msg.sessionId !== ctx.sessionId) return;
      if (!isRuntimeCompatible({ protocol: msg.protocol, sdkVersion: ctx.sdk.hostVersion }, { protocol: PROTOCOL_VERSION, sdkVersion: SDK_VERSION })
        || ctx.sdk.protocol !== PROTOCOL_VERSION) {
        fail("INCOMPATIBLE", `Platform SDK ${ctx.sdk.hostVersion} (protocol ${ctx.sdk.protocol}) is not compatible with this game's SDK ${SDK_VERSION} (protocol ${PROTOCOL_VERSION}).`, ctx.sessionId);
        return;
      }
      if (ctx.gameId !== manifest.id || ctx.gameVersion !== manifest.version) {
        fail("WRONG_GAME", `This session is for ${ctx.gameId} ${ctx.gameVersion}, not ${manifest.id} ${manifest.version}.`, ctx.sessionId);
        return;
      }
      if (!manifest.formats.includes(ctx.format)) {
        fail("INCOMPATIBLE", `The game does not support the ${ctx.format} format.`, ctx.sessionId);
        return;
      }
      if (ctx.status !== "READY" || ctx.timing.startedAt !== null) {
        fail("SESSION_NOT_PLAYABLE", `The session is ${ctx.status}; a game can only be launched for a READY session.`, ctx.sessionId);
        return;
      }
      settled = true;
      stop();
      env.clearTimer(timer);
      resolve(createSession(env, manifest, ctx, options.submitTimeoutMs ?? 60_000));
    });

    const timer = env.setTimer(() => fail("HOST_TIMEOUT", "The platform did not provide a session in time.", null), options.timeoutMs ?? 10_000);
    env.post(envelope("hello", null, { sdkVersion: SDK_VERSION, gameId: manifest.id, gameVersion: manifest.version }));
  });
}

function createSession(env: SdkEnvironment, manifest: GameManifest, context: SessionContext, submitTimeoutMs: number): GameSdk {
  const ctx: Readonly<SessionContext> = Object.freeze(structuredClone(context));
  let phase: GamePhase = "connected";
  let timing = toTiming(ctx.timing, env);
  const handlers: { [E in keyof GameSdkEvents]: Set<GameSdkEvents[E]> } = {
    start: new Set(), pause: new Set(), resume: new Set(), terminate: new Set(), result: new Set(),
  };
  let submission: { id: string; score: number; promise: Promise<SubmitOutcome>; settle: (o: SubmitOutcome) => void; timer: unknown } | null = null;

  const emit = <E extends keyof GameSdkEvents>(event: E, ...args: Parameters<GameSdkEvents[E]>) => {
    for (const h of [...handlers[event]]) {
      try {
        (h as (...a: Parameters<GameSdkEvents[E]>) => void)(...args);
      } catch (err) {
        // A failing game handler must not break the SDK; report it to the platform.
        send("error", { code: "HANDLER_ERROR", message: String(err instanceof Error ? err.message : err).slice(0, 200), fatal: false });
      }
    }
  };
  const send = <T extends GameMessage["type"]>(type: T, payload: PayloadOf<T>) => {
    if (phase !== "disposed") env.post(envelope(type, ctx.sessionId, payload));
  };

  const settleSubmission = (outcome: SubmitOutcome) => {
    if (!submission) return;
    env.clearTimer(submission.timer);
    submission.settle(outcome);
    if (phase === "submitting") phase = "finished";
    emit("result", outcome);
  };

  const onHost = (msg: HostMessage) => {
    switch (msg.type) {
      case "start":
        if (phase !== "ready" || msg.payload.timing.startedAt === null) return;
        timing = toTiming(msg.payload.timing, env);
        phase = "playing";
        emit("start", timing);
        return;
      case "pause":
        if (phase !== "playing") return;
        phase = "paused";
        emit("pause");
        return;
      case "resume":
        if (phase !== "paused") return;
        timing = toTiming(msg.payload.timing, env);
        phase = "playing";
        emit("resume", timing);
        return;
      case "submit-result":
        if (submission && msg.payload.submissionId === submission.id) settleSubmission(msg.payload.outcome);
        return;
      case "terminate":
        if (phase === "terminated") return;
        if (submission && phase === "submitting") settleSubmission({ status: "unresolved", message: "The platform closed the game before confirming the result." });
        phase = "terminated";
        emit("terminate", { reason: msg.payload.reason, status: msg.payload.status, message: msg.payload.message });
        return;
      case "init":
      case "error":
        return; // a second init is ignored; host notices are informational
    }
  };

  const stop = env.listen((m) => {
    if (phase === "disposed" || !env.isFromHost(m)) return;
    const msg = parseHostMessage(m.data);
    if (!msg || msg.protocol !== PROTOCOL_VERSION || msg.sessionId !== ctx.sessionId) return;
    onHost(msg);
  });

  const sdk: GameSdk = {
    version: SDK_VERSION,
    context: ctx,
    get phase() {
      return phase;
    },
    ready() {
      if (phase !== "connected") throw new SdkError("INVALID_STATE", `ready() can only be called once, before start (phase: ${phase}).`);
      phase = "ready";
      send("ready", {});
    },
    on(event, handler) {
      if (phase === "disposed") throw new SdkError("DISPOSED", "The SDK has been disposed.");
      const set = handlers[event] as Set<typeof handler>;
      set.add(handler);
      return () => set.delete(handler);
    },
    timing: () => timing,
    submitResult({ score }) {
      if (submission) {
        return submission.score === score
          ? submission.promise
          : Promise.reject(new SdkError("DUPLICATE_SUBMISSION", "A different result was already submitted for this session."));
      }
      if (phase !== "playing" && phase !== "paused") {
        return Promise.reject(new SdkError("INVALID_STATE", `Results can only be submitted during gameplay (phase: ${phase}).`));
      }
      if (!isValidScore(score)) {
        return Promise.reject(new SdkError("INVALID_SCORE", "The score must be a whole number from 0 to 1,000,000,000,000."));
      }
      let settle!: (o: SubmitOutcome) => void;
      const promise = new Promise<SubmitOutcome>((r) => { settle = r; });
      const id = env.randomId();
      const timer = env.setTimer(
        () => settleSubmission({ status: "unresolved", message: "No answer from the platform yet. The result may still be saved." }),
        submitTimeoutMs,
      );
      submission = { id, score, promise, settle, timer };
      phase = "submitting";
      send("submit", { submissionId: id, score, gameVersion: manifest.version });
      return promise;
    },
    reportError(code, message, options) {
      const safeCode = /^[A-Z_]{1,40}$/.test(code) ? code : "GAME_ERROR";
      send("error", { code: safeCode, message: String(message).slice(0, 200), fatal: options?.fatal ?? false });
    },
    exit() {
      send("exit", {});
    },
    dispose() {
      if (phase === "disposed") return;
      if (submission) env.clearTimer(submission.timer);
      stop();
      phase = "disposed";
      for (const set of Object.values(handlers)) set.clear();
    },
  };
  return sdk;
}
