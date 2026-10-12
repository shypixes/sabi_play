import { randomUUID } from "node:crypto";
import {
  connectToPlatform,
  type GameManifestInput,
  type GameMessage,
  type GameSdk,
  type HostMessage,
  type InboundMessage,
  type MessagePortLike,
  type ResultSubmission,
  type SdkEnvironment,
  type SessionView,
} from "@/game-sdk";
import { GameHostController, type LaunchInfo } from "@/lib/game-host/controller";
import { PlatformApiError } from "@/lib/game-host/platform-api";

/**
 * MOCKED test doubles for the Game SDK tests. FakeBackend models the competition rules verified
 * against the real database (READY -> IN_PROGRESS -> COMPLETED for practice, deadline =
 * start + limit + grace, one result per session, late result -> ABANDONED + 409). It is NOT the
 * real backend: the real routes are covered in tests/integration and tests/db.
 */

export const HOST_ORIGIN = "https://sabi.example";

export class FakeClock {
  t = Date.parse("2026-10-11T12:00:00.000Z");
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  /** Advance time, running due timers in order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  pending() {
    return this.timers.length;
  }
}

type Failure = { error: PlatformApiError; applied: boolean };
type Op = "createSession" | "getSession" | "startSession" | "submitResult" | "cancelSession";

export const networkError = () => new PlatformApiError("network", null, null, "Could not reach the platform.");
export const httpError = (status: number, message = "nope", code = "CONFLICT") => new PlatformApiError("http", status, code, message);

export class FakeBackend {
  sessions = new Map<string, SessionView>();
  calls: { op: Op; args: unknown[] }[] = [];
  /** Queued failures per operation (FIFO). `applied` = the operation took effect but the response was lost. */
  failures: Partial<Record<Op, Failure[]>> = {};
  /** When set, every call to the operation fails with a network error (not applied). */
  down = new Set<Op>();
  gameId = "pop-rush";
  constructor(private readonly clock: FakeClock, private readonly limitSeconds = 180, private readonly graceSeconds = 30) {}

  failNext(op: Op, error: PlatformApiError, applied = false) {
    (this.failures[op] ??= []).push({ error, applied });
  }

  private async run<T>(op: Op, args: unknown[], fn: () => T): Promise<T> {
    this.calls.push({ op, args });
    await Promise.resolve();
    if (this.down.has(op)) throw networkError();
    const f = this.failures[op]?.shift();
    if (f) {
      if (f.applied) fn();
      throw f.error;
    }
    return fn();
  }

  private iso = () => new Date(this.clock.now()).toISOString();

  private get(id: string): SessionView {
    const s = this.sessions.get(id);
    if (!s) throw httpError(404, "Session not found.", "NOT_FOUND");
    return s;
  }

  private put(s: SessionView): SessionView {
    this.sessions.set(s.sessionId, s);
    return structuredClone(s);
  }

  api = {
    createSession: (configId: string) => this.run("createSession", [configId], () => this.put({
      sessionId: randomUUID(), configId, gameId: this.gameId, format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY",
      validationStatus: "UNVERIFIED", settlementStatus: "NOT_REQUIRED", yourSlot: 1, participantCount: 1, requiredParticipants: 1,
      createdAt: this.iso(), startedAt: null, deadlineAt: null, completedAt: null, result: null,
    })),
    getSession: (id: string) => this.run("getSession", [id], () => structuredClone(this.get(id))),
    startSession: (id: string) => this.run("startSession", [id], () => {
      const s = this.get(id);
      if (s.status !== "READY") throw httpError(409, "Only a READY session can be started.");
      return this.put({ ...s, status: "IN_PROGRESS", startedAt: this.iso(),
        deadlineAt: new Date(this.clock.now() + (this.limitSeconds + this.graceSeconds) * 1000).toISOString() });
    }),
    submitResult: (id: string, r: ResultSubmission) => this.run("submitResult", [id, r], () => {
      const s = this.get(id);
      if (r.format !== "SCORE_ATTACK") throw httpError(400, "Invalid input.", "VALIDATION_ERROR");
      if (s.status === "IN_PROGRESS" && s.deadlineAt && this.clock.now() > Date.parse(s.deadlineAt)) {
        this.put({ ...s, status: "ABANDONED", completedAt: this.iso() });
        throw httpError(409, "The time limit for this session has passed.");
      }
      if (s.status !== "IN_PROGRESS") throw httpError(409, "This session does not accept results.");
      return this.put({ ...s, status: "COMPLETED", completedAt: this.iso(), result: { format: "SCORE_ATTACK", score: r.score } });
    }),
    cancelSession: (id: string) => this.run("cancelSession", [id], () => {
      const s = this.get(id);
      if (s.status === "READY") return this.put({ ...s, status: "CANCELLED", completedAt: this.iso() });
      if (s.status === "IN_PROGRESS") return this.put({ ...s, status: "ABANDONED", completedAt: this.iso() });
      throw httpError(409, "This session can no longer be cancelled.");
    }),
  };

  count(op: Op) {
    return this.calls.filter((c) => c.op === op).length;
  }
}

/**
 * One end of a fake MessageChannel with the browser's semantics that matter here: structured
 * clone, async delivery, messages queued until start(), and close() disentangling both ends
 * (later posts in either direction are dropped). Delivery is on microtasks (the real Node
 * MessageChannel uses macrotasks, which the microtask-based `flush` would not drain).
 */
export class FakePort implements MessagePortLike {
  other: FakePort | null = null;
  closed = false;
  /** Observes every message posted FROM this end (for test assertions). */
  onSend: ((message: unknown) => void) | null = null;
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private queue: unknown[] = [];
  private started = false;
  postMessage(message: unknown) {
    const target = this.other;
    if (this.closed || !target || target.closed) return;
    const copy = structuredClone(message);
    this.onSend?.(copy);
    queueMicrotask(() => target.receive(copy));
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
    this.listeners.delete(listener);
  }
  start() {
    if (this.started) return;
    this.started = true;
    const queued = this.queue;
    this.queue = [];
    for (const data of queued) this.receive(data);
  }
  close() {
    this.closed = true;
    this.listeners.clear();
    if (this.other) this.other.closed = true;
  }
  private receive(data: unknown) {
    if (this.closed) return;
    if (!this.started) {
      this.queue.push(data);
      return;
    }
    for (const l of [...this.listeners]) l({ data });
  }
}

export function fakeChannel(): [FakePort, FakePort] {
  const a = new FakePort();
  const b = new FakePort();
  a.other = b;
  b.other = a;
  return [a, b];
}

/** Fake browser environment for the SDK side. Deliveries are async (like postMessage). */
export class FakeGameEnv implements SdkEnvironment {
  readonly hostWindow = { name: "host" };
  /** Everything the game sent: window posts (hello / pre-channel errors) and channel posts. */
  sent: GameMessage[] = [];
  private handlers = new Set<(m: InboundMessage) => void>();
  onPost: ((m: GameMessage) => void) | null = null;
  /** Ends of the most recent channel opened with openChannel. */
  hostPort: FakePort | null = null;
  gamePort: FakePort | null = null;
  private ids = 0;
  constructor(private readonly clock: FakeClock) {}
  listen(handler: (m: InboundMessage) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  isFromHost = (m: InboundMessage) => m.source === this.hostWindow && m.origin === HOST_ORIGIN;
  post(message: GameMessage) {
    const copy = structuredClone(message);
    this.sent.push(copy);
    queueMicrotask(() => this.onPost?.(copy));
  }
  now = () => this.clock.now();
  randomId = () => `00000000-0000-4000-8000-${String(++this.ids).padStart(12, "0")}`;
  setTimer = (fn: () => void, ms: number) => this.clock.setTimer(fn, ms);
  clearTimer = (h: unknown) => this.clock.clearTimer(h);
  /** Deliver a message to the game as if posted by `source` from `origin`. */
  deliver(data: unknown, source: unknown = this.hostWindow, origin = HOST_ORIGIN, ports?: readonly MessagePortLike[]) {
    const copy = structuredClone(data);
    queueMicrotask(() => {
      for (const h of [...this.handlers]) h({ data: copy, origin, source, ...(ports ? { ports } : {}) });
    });
  }
  /** What the host does for init: deliver it from the host window with a fresh channel port; returns the host end. */
  openChannel(init: unknown): FakePort {
    const [hostPort, gamePort] = fakeChannel();
    gamePort.onSend = (m) => this.sent.push(m as GameMessage);
    this.hostPort = hostPort;
    this.gamePort = gamePort;
    this.deliver(init, this.hostWindow, HOST_ORIGIN, [gamePort]);
    return hostPort;
  }
  /** A post-init host message: travels over the channel. */
  fromHost(data: unknown) {
    if (!this.hostPort) throw new Error("no channel: deliver init with openChannel first");
    this.hostPort.postMessage(data);
  }
  listenerCount() {
    return this.handlers.size;
  }
}

export const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

export const POP_RUSH_TEST_MANIFEST: GameManifestInput = {
  schemaVersion: 1, id: "pop-rush", name: "Pop Rush", version: "1.0.0", status: "ACTIVE", entry: "game.ts",
  sdk: { min: "1.0.0", maxExclusive: "2.0.0" }, formats: ["SCORE_ATTACK"], inputs: ["touch"], orientations: ["portrait"],
  capabilities: [], metadata: { description: "d", howToPlay: "h" }, gameConfig: { maxBubbles: 7 },
};

export const LAUNCH: LaunchInfo = { gameId: "pop-rush", gameVersion: "1.0.0", configId: randomUUID(), timeLimitSeconds: 180, gameConfig: { maxBubbles: 7 } };

/**
 * Wires the REAL host controller to the REAL SDK client through fake windows: the same message
 * path as the browser (structured clone, async delivery, source/origin checks) without a DOM.
 */
export function linkedHarness(opts: { manifest?: unknown; backend?: FakeBackend; clock?: FakeClock; launch?: LaunchInfo } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const backend = opts.backend ?? new FakeBackend(clock);
  const env = new FakeGameEnv(clock);
  const frameWindow = { name: "frame" };
  const hostReceived: HostMessage[] = [];
  const controller = new GameHostController({
    api: backend.api,
    launch: opts.launch ?? LAUNCH,
    now: clock.now,
    sleep: async () => undefined,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    retryBaseDelayMs: 1,
  });
  controller.attachFrame({
    post: (m) => {
      hostReceived.push(structuredClone(m));
      env.deliver(m);
    },
    openChannel: (init) => {
      hostReceived.push(structuredClone(init));
      const port = env.openChannel(init);
      port.onSend = (m) => hostReceived.push(m as HostMessage);
      return port;
    },
    isFromGame: (m) => m.source === frameWindow && m.origin === "null",
  });
  env.onPost = (m) => controller.receive({ data: m, origin: "null", source: frameWindow });
  /** Inject a raw message on the frame WINDOW, as if posted by whatever document the frame holds (or by another window). */
  const fromGame = (data: unknown, source: unknown = frameWindow, origin = "null") => controller.receive({ data, origin, source });
  /** Inject a raw message on the game document's private channel (as the game code could). */
  const fromGamePort = (data: unknown) => {
    if (!env.gamePort) throw new Error("no channel yet");
    env.gamePort.postMessage(data);
  };
  const connect = (manifest: unknown = opts.manifest ?? POP_RUSH_TEST_MANIFEST): Promise<GameSdk> =>
    connectToPlatform({ manifest, env, timeoutMs: 5000, submitTimeoutMs: 60_000 });
  return { clock, backend, env, controller, frameWindow, hostReceived, fromGame, fromGamePort, connect };
}
