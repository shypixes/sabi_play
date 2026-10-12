import { describe, expect, it } from "vitest";
import { MESSAGE_CHANNEL, PROTOCOL_VERSION, SDK_VERSION, SdkError, connectToPlatform, type GameSdk } from "@/game-sdk";
import { FakeClock, FakeGameEnv, POP_RUSH_TEST_MANIFEST, fakeChannel, flush } from "../helpers/game-fakes";

// UNIT (MOCKED host): the SDK client alone, driven by hand-written host messages.

const SID = "3f0c6a8e-6b4f-4a51-9a39-1c2b3d4e5f60";
const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const notStarted = { timeLimitSeconds: 180, graceSeconds: 30, startedAt: null, endsAt: null, deadlineAt: null, serverOffsetMs: 0 };
const started = (offset = 0) => ({ timeLimitSeconds: 180, graceSeconds: 30, startedAt: iso(T0), endsAt: iso(T0 + 180_000), deadlineAt: iso(T0 + 210_000), serverOffsetMs: offset });
const context = (over: Record<string, unknown> = {}) => ({
  sessionId: SID, gameId: "pop-rush", gameVersion: "1.0.0", format: "SCORE_ATTACK", mode: "PRACTICE", status: "READY",
  gameConfig: { maxBubbles: 7 }, timing: notStarted, sdk: { hostVersion: SDK_VERSION, protocol: PROTOCOL_VERSION }, ...over,
});
const host = (type: string, payload: unknown, sessionId = SID) => ({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type, sessionId, payload });

function setup() {
  const clock = new FakeClock();
  const env = new FakeGameEnv(clock);
  return { clock, env };
}

async function connected(over: Record<string, unknown> = {}) {
  const { clock, env } = setup();
  const p = connectToPlatform({ manifest: POP_RUSH_TEST_MANIFEST, env, submitTimeoutMs: 60_000 });
  env.openChannel(host("init", { context: context(over) }));
  await flush();
  return { clock, env, sdk: await p };
}

async function playing(): Promise<{ clock: FakeClock; env: FakeGameEnv; sdk: GameSdk }> {
  const r = await connected();
  r.sdk.ready();
  r.env.fromHost(host("start", { timing: started() }));
  await flush();
  return r;
}

describe("connectToPlatform", () => {
  it("announces itself with hello (no session yet) and resolves on a valid context", async () => {
    const { env, sdk } = await connected();
    expect(env.sent[0]).toMatchObject({ type: "hello", sessionId: null, payload: { sdkVersion: SDK_VERSION, gameId: "pop-rush", gameVersion: "1.0.0" } });
    expect(sdk.phase).toBe("connected");
    expect(Object.isFrozen(sdk.context)).toBe(true);
    expect(sdk.context.gameConfig).toEqual({ maxBubbles: 7 });
  });

  it("ignores contexts from other windows or origins, then times out", async () => {
    const { clock, env } = setup();
    const p = connectToPlatform({ manifest: POP_RUSH_TEST_MANIFEST, env, timeoutMs: 1000 });
    // Even with a channel port attached, an init from another window or origin is ignored.
    env.deliver(host("init", { context: context() }), { name: "evil" }, undefined, [fakeChannel()[1]]);
    env.deliver(host("init", { context: context() }), env.hostWindow, "https://evil.example", [fakeChannel()[1]]);
    env.deliver({ junk: true });
    await flush();
    clock.advance(1000);
    await expect(p).rejects.toMatchObject({ code: "HOST_TIMEOUT" });
    expect(env.listenerCount()).toBe(0);
  });

  it("rejects an invalid or incompatible manifest before talking to the host", async () => {
    const { env } = setup();
    await expect(connectToPlatform({ manifest: { ...POP_RUSH_TEST_MANIFEST, version: "x" }, env })).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    await expect(connectToPlatform({ manifest: { ...POP_RUSH_TEST_MANIFEST, sdk: { min: "2.0.0", maxExclusive: "3.0.0" } }, env }))
      .rejects.toMatchObject({ code: "INCOMPATIBLE" });
    expect(env.sent).toHaveLength(0);
  });

  it("refuses a context for another game, version, format, or a non-READY session, and tells the host", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ gameId: "sum-sprint" }, "WRONG_GAME"],
      [{ gameVersion: "1.0.1" }, "WRONG_GAME"],
      [{ format: "ONE_V_ONE" }, "INCOMPATIBLE"],
      [{ status: "IN_PROGRESS" }, "SESSION_NOT_PLAYABLE"],
      [{ timing: started() }, "SESSION_NOT_PLAYABLE"],
      [{ sdk: { hostVersion: "2.0.0", protocol: PROTOCOL_VERSION } }, "INCOMPATIBLE"],
      [{ sdk: { hostVersion: SDK_VERSION, protocol: PROTOCOL_VERSION - 1 } }, "INCOMPATIBLE"],
    ];
    for (const [over, code] of cases) {
      const { env } = setup();
      const windowPosts: string[] = [];
      env.onPost = (m) => windowPosts.push(m.type);
      const p = connectToPlatform({ manifest: POP_RUSH_TEST_MANIFEST, env });
      env.openChannel(host("init", { context: context(over) }));
      await flush();
      await expect(p, JSON.stringify(over)).rejects.toMatchObject({ code });
      expect(env.sent.at(-1)).toMatchObject({ type: "error", payload: { fatal: true } });
      // The refusal goes back over the channel the host just opened; the window only carried hello.
      expect(windowPosts).toEqual(["hello"]);
    }
  });

  it("refuses an init that does not carry a private channel port", async () => {
    const { env } = setup();
    const p = connectToPlatform({ manifest: POP_RUSH_TEST_MANIFEST, env });
    env.deliver(host("init", { context: context() })); // right window and origin, but no port
    await flush();
    await expect(p).rejects.toMatchObject({ code: "INCOMPATIBLE" });
    expect(env.sent.at(-1)).toMatchObject({ type: "error", payload: { fatal: true } });
  });

  it("after the handshake, trusts only the channel: host-window messages are ignored", async () => {
    const { env, sdk } = await connected();
    const windowPosts: string[] = [];
    env.onPost = (m) => windowPosts.push(m.type);
    const starts: unknown[] = [];
    sdk.on("start", (t) => starts.push(t));
    sdk.ready();
    env.deliver(host("start", { timing: started() })); // the right window and origin, but not the channel
    await flush();
    expect(starts).toHaveLength(0);
    expect(sdk.phase).toBe("ready");
    env.fromHost(host("start", { timing: started() }));
    await flush();
    expect(starts).toHaveLength(1);
    void sdk.submitResult({ score: 3 }); // no answer needed here
    await flush();
    // The game's messages after init (ready, submit) went over the channel, never the window.
    expect(env.sent.map((m) => m.type)).toEqual(["hello", "ready", "submit"]);
    expect(windowPosts).toEqual([]);
  });

  it("fails outside a frame in the browser environment", async () => {
    await expect(connectToPlatform({ manifest: POP_RUSH_TEST_MANIFEST })).rejects.toMatchObject({ code: "NOT_IN_FRAME" });
  });
});

describe("game session", () => {
  it("ready() once; start only after ready; start without a server time is ignored", async () => {
    const { env, sdk } = await connected();
    const starts: unknown[] = [];
    sdk.on("start", (t) => starts.push(t));
    env.fromHost(host("start", { timing: started() }));
    await flush();
    expect(starts).toHaveLength(0); // not ready yet
    sdk.ready();
    expect(() => sdk.ready()).toThrow(SdkError);
    env.fromHost(host("start", { timing: notStarted }));
    await flush();
    expect(starts).toHaveLength(0);
    env.fromHost(host("start", { timing: started() }));
    env.fromHost(host("start", { timing: started() })); // duplicate
    await flush();
    expect(starts).toHaveLength(1);
    expect(sdk.phase).toBe("playing");
  });

  it("ignores host messages for another session or protocol", async () => {
    const { env, sdk } = await connected();
    sdk.ready();
    env.fromHost(host("start", { timing: started() }, "11111111-1111-4111-8111-111111111111"));
    env.fromHost({ ...host("start", { timing: started() }), protocol: PROTOCOL_VERSION + 1 });
    await flush();
    expect(sdk.phase).toBe("ready");
  });

  it("timing follows the server clock and is unaffected by pause", async () => {
    const { clock, env, sdk } = await connected();
    sdk.ready();
    clock.t = T0 - 2000; // device clock 2 s behind the server
    env.fromHost(host("start", { timing: started(2000) }));
    await flush();
    expect(sdk.timing().remainingMs()).toBe(180_000);
    env.fromHost(host("pause", { reason: "hidden" }));
    await flush();
    expect(sdk.phase).toBe("paused");
    clock.advance(200_000);
    expect(sdk.timing().remainingMs()).toBe(0);
  });

  it("validates scores and enforces one result", async () => {
    const { sdk } = await playing();
    for (const score of [-1, 1.5, Number.NaN, 1e13, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(sdk.submitResult({ score })).rejects.toMatchObject({ code: "INVALID_SCORE" });
    }
    const p = sdk.submitResult({ score: 10 });
    expect(sdk.submitResult({ score: 10 })).toBe(p);
    await expect(sdk.submitResult({ score: 12 })).rejects.toMatchObject({ code: "DUPLICATE_SUBMISSION" });
  });

  it("sends exactly the documented submit fields", async () => {
    const { env, sdk } = await playing();
    void sdk.submitResult({ score: 10 });
    const submit = env.sent.at(-1);
    expect(submit).toMatchObject({ type: "submit", sessionId: SID });
    expect(Object.keys(submit!.payload).sort()).toEqual(["gameVersion", "score", "submissionId"]);
  });

  it("resolves with the host's outcome only for its own submission id", async () => {
    const { env, sdk } = await playing();
    const p = sdk.submitResult({ score: 10 });
    const id = (env.sent.at(-1)!.payload as { submissionId: string }).submissionId;
    const outcome = { status: "completed", score: 10, validation: "UNVERIFIED", settlement: "NOT_REQUIRED", completedAt: iso(T0 + 1) };
    env.fromHost(host("submit-result", { submissionId: "00000000-0000-4000-8000-0000000000ff", outcome: { status: "rejected", reason: "EXPIRED", message: "x" } }));
    env.fromHost(host("submit-result", { submissionId: id, outcome }));
    await flush();
    expect(await p).toEqual(outcome);
    expect(sdk.phase).toBe("finished");
  });

  it("no answer within the timeout is 'unresolved' (not a rejection); a late answer arrives as a result event", async () => {
    const { clock, env, sdk } = await playing();
    const results: string[] = [];
    sdk.on("result", (o) => results.push(o.status));
    const p = sdk.submitResult({ score: 10 });
    const id = (env.sent.at(-1)!.payload as { submissionId: string }).submissionId;
    clock.advance(60_000);
    expect((await p).status).toBe("unresolved");
    env.fromHost(host("submit-result", { submissionId: id, outcome: { status: "completed", score: 10, validation: "UNVERIFIED", settlement: "NOT_REQUIRED", completedAt: null } }));
    await flush();
    expect(results).toEqual(["unresolved", "completed"]);
  });

  it("a throwing game handler does not break the SDK and is reported", async () => {
    const { env, sdk } = await connected();
    sdk.on("start", () => { throw new Error("boom"); });
    const ok: string[] = [];
    sdk.on("start", () => ok.push("second handler ran"));
    sdk.ready();
    env.fromHost(host("start", { timing: started() }));
    await flush();
    expect(ok).toHaveLength(1);
    expect(env.sent.at(-1)).toMatchObject({ type: "error", payload: { code: "HANDLER_ERROR", fatal: false } });
  });

  it("sanitises reported error codes and bounds messages", async () => {
    const { env, sdk } = await connected();
    sdk.reportError("not valid!", "x".repeat(500));
    expect(env.sent.at(-1)).toMatchObject({ type: "error", payload: { code: "GAME_ERROR" } });
    expect((env.sent.at(-1)!.payload as { message: string }).message).toHaveLength(200);
  });

  it("dispose removes listeners and timers and is idempotent", async () => {
    const { clock, env, sdk } = await playing();
    void sdk.submitResult({ score: 1 });
    sdk.dispose();
    sdk.dispose();
    expect(env.listenerCount()).toBe(0);
    expect(clock.pending()).toBe(0);
    expect(sdk.phase).toBe("disposed");
    const before = env.sent.length;
    sdk.exit();
    expect(env.sent.length).toBe(before);
  });
});
