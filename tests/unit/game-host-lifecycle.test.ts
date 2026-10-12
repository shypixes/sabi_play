import { describe, expect, it } from "vitest";
import { MESSAGE_CHANNEL, PROTOCOL_VERSION, SdkError, type GameSdk, type SubmitOutcome } from "@/game-sdk";
import { MAX_PROTOCOL_VIOLATIONS } from "@/lib/game-host/controller";
import { PlatformApiError } from "@/lib/game-host/platform-api";
import { FakeBackend, FakeClock, flush, httpError, linkedHarness, networkError, type FakeGameEnv } from "../helpers/game-fakes";

// UNIT (MOCKED backend): the REAL GameHostController and the REAL SDK client talking through
// fake windows. FakeBackend mirrors the verified competition rules; real routes/DB are covered
// by tests/integration/game-host-api.test.ts and tests/db/game-sdk-practice.test.ts.

/** Create a session and connect the game; returns once the host has sent the context. */
async function launch(h: ReturnType<typeof linkedHarness>) {
  await h.controller.createSession();
  expect(h.controller.getState().phase).toBe("loading");
  const sdkPromise = h.connect();
  await flush();
  const sdk = await sdkPromise;
  return sdk;
}

async function readyAndStart(h: ReturnType<typeof linkedHarness>, sdk: GameSdk) {
  const starts: number[] = [];
  sdk.on("start", (t) => starts.push(t.startedAt ?? -1));
  sdk.ready();
  await flush();
  expect(h.controller.getState().phase).toBe("ready");
  await h.controller.start();
  await flush();
  expect(starts).toHaveLength(1);
  return starts;
}

const sessionOf = (h: ReturnType<typeof linkedHarness>) => {
  const id = h.controller.getState().session?.sessionId;
  if (!id) throw new Error("no session");
  return h.backend.sessions.get(id)!;
};

const lastHostMessage = (h: ReturnType<typeof linkedHarness>) => h.hostReceived.at(-1);

describe("lifecycle: init -> context -> ready -> authorised start -> submit -> completion", () => {
  it("completes a practice session end to end", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    expect(sdk.phase).toBe("connected");
    expect(sdk.context.status).toBe("READY");
    expect(sdk.context.mode).toBe("PRACTICE");
    expect(sdk.context.timing.startedAt).toBeNull();

    await readyAndStart(h, sdk);
    expect(sdk.phase).toBe("playing");
    expect(sessionOf(h).status).toBe("IN_PROGRESS");
    const remaining = sdk.timing().remainingMs();
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(179_000);
    expect(remaining!).toBeLessThanOrEqual(180_000);

    h.clock.advance(180_000);
    expect(sdk.timing().remainingMs()).toBe(0);
    const outcome = sdk.submitResult({ score: 4321 });
    await flush(40);
    expect(await outcome).toEqual({
      status: "completed", score: 4321, validation: "UNVERIFIED", settlement: "NOT_REQUIRED", completedAt: sessionOf(h).completedAt,
    });
    expect(sdk.phase).toBe("finished");
    expect(h.controller.getState().phase).toBe("completed");
    expect(sessionOf(h)).toMatchObject({ status: "COMPLETED", validationStatus: "UNVERIFIED", settlementStatus: "NOT_REQUIRED", result: { score: 4321 } });
    expect(h.backend.count("submitResult")).toBe(1);
    sdk.dispose();
  });

  it("the session context contains only the documented fields (no user, wallet or secrets)", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    expect(Object.keys(sdk.context).sort()).toEqual(["format", "gameConfig", "gameId", "gameVersion", "mode", "sdk", "sessionId", "status", "timing"]);
    expect(JSON.stringify(h.hostReceived)).not.toMatch(/user|email|wallet|balance|token|cookie/i);
  });

  it("loading and ready never start the round; only the platform's start does", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    sdk.ready();
    await flush();
    h.clock.advance(60_000);
    expect(sessionOf(h).status).toBe("READY");
    expect(sdk.phase).toBe("ready");
    await expect(sdk.submitResult({ score: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(h.backend.count("startSession")).toBe(0);
  });

  it("a game cannot start, cancel or settle by message; out-of-sequence messages are violations", async () => {
    const h = linkedHarness();
    await launch(h);
    const sid = h.controller.getState().session!.sessionId;
    for (const type of ["start", "cancel", "settle", "submit-result"]) {
      h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type, sessionId: sid, payload: {} });
    }
    // submit before start (valid shape, wrong phase)
    h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "submit", sessionId: sid,
      payload: { submissionId: "00000000-0000-4000-8000-000000000099", score: 5, gameVersion: "1.0.0" } });
    h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "exit", sessionId: sid, payload: {} });
    await flush();
    expect(h.controller.getState().violations).toBe(6);
    expect(sessionOf(h)).toMatchObject({ status: "READY", result: null });
    expect(h.backend.count("startSession") + h.backend.count("submitResult") + h.backend.count("cancelSession")).toBe(0);
  });

  it("ignores messages from any other window or origin entirely", async () => {
    const h = linkedHarness();
    await launch(h);
    const sid = h.controller.getState().session!.sessionId;
    const ready = { channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "ready", sessionId: sid, payload: {} };
    h.fromGame(ready, { name: "other-window" });
    h.fromGame(ready, h.frameWindow, "https://evil.example");
    h.fromGame(ready, h.frameWindow, HOST_LIKE_ORIGIN);
    expect(h.controller.getState()).toMatchObject({ phase: "awaiting_ready", violations: 0 });
  });

  it("rejects messages for another session", async () => {
    const h = linkedHarness();
    await launch(h);
    h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "ready", sessionId: "11111111-1111-4111-8111-111111111111", payload: {} });
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "awaiting_ready", violations: 1 });
    expect(lastHostMessage(h)).toMatchObject({ type: "error", payload: { code: "WRONG_SESSION" } });
  });

  it("stops the game after too many invalid messages and releases the unstarted session", async () => {
    const h = linkedHarness();
    await launch(h);
    for (let i = 0; i < MAX_PROTOCOL_VIOLATIONS; i++) h.fromGamePort({ garbage: i });
    await flush();
    expect(h.controller.getState().phase).toBe("failed");
    expect(h.hostReceived.find((m) => m.type === "terminate")).toMatchObject({ payload: { reason: "protocol_error" } });
    expect(sessionOf(h).status).toBe("CANCELLED");
  });

  it("a restarted game (second hello on the window) revokes the frame and is never re-initialised", async () => {
    const h = linkedHarness();
    await launch(h);
    const sent = h.hostReceived.length;
    h.fromGame({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "hello", sessionId: null,
      payload: { sdkVersion: "1.0.0", gameId: "pop-rush", gameVersion: "1.0.0" } });
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "failed", frameRevoked: true });
    expect(h.hostReceived.length).toBe(sent); // nothing (no second init) goes to the new document
    expect(sessionOf(h).status).toBe("CANCELLED");
  });

  it("hello on the private channel is a violation (it is only sent once, before the context)", async () => {
    const h = linkedHarness();
    await launch(h);
    h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "hello", sessionId: null,
      payload: { sdkVersion: "1.0.0", gameId: "pop-rush", gameVersion: "1.0.0" } });
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "awaiting_ready", violations: 1, frameRevoked: false });
    expect(h.hostReceived.filter((m) => m.type === "init")).toHaveLength(1);
  });

  it("refuses the wrong game or an incompatible SDK at hello", async () => {
    for (const payload of [
      { sdkVersion: "1.0.0", gameId: "sum-sprint", gameVersion: "1.0.0" },
      { sdkVersion: "1.0.0", gameId: "pop-rush", gameVersion: "0.9.0" },
      { sdkVersion: "2.0.0", gameId: "pop-rush", gameVersion: "1.0.0" },
    ]) {
      const h = linkedHarness();
      await h.controller.createSession();
      h.fromGame({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "hello", sessionId: null, payload });
      await flush();
      expect(h.controller.getState().phase).toBe("failed");
      expect(h.hostReceived.some((m) => m.type === "init")).toBe(false);
      expect(sessionOf(h).status).toBe("CANCELLED");
    }
  });

  it("a game that never becomes ready times out and the session is released", async () => {
    const h = linkedHarness();
    await launch(h);
    h.clock.advance(20_000);
    await flush();
    expect(h.controller.getState()).toMatchObject({ phase: "failed" });
    expect(sessionOf(h).status).toBe("CANCELLED");
  });

  it("a fatal game error before start releases the session", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    sdk.reportError("ASSETS_FAILED", "could not decode", { fatal: true });
    await flush();
    expect(h.controller.getState().phase).toBe("failed");
    expect(sessionOf(h).status).toBe("CANCELLED");
  });

  it("refuses a created session that does not match the launch", async () => {
    const clock = new FakeClock();
    const backend = new FakeBackend(clock);
    backend.gameId = "sum-sprint";
    const h = linkedHarness({ clock, backend });
    await h.controller.createSession();
    await flush();
    expect(h.controller.getState().phase).toBe("failed");
    expect(sessionOf(h).status).toBe("CANCELLED");
  });
});

describe("official timing", () => {
  it("uses the server start time and corrects device clock skew", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    sdk.ready();
    await flush();
    // Server clock is 5 s ahead of the device: the fake backend stamps startedAt with clock+5000.
    const realStart = h.backend.api.startSession;
    h.backend.api.startSession = async (id: string) => {
      const v = await realStart(id);
      const shifted = { ...v, startedAt: new Date(Date.parse(v.startedAt!) + 5000).toISOString(), deadlineAt: new Date(Date.parse(v.deadlineAt!) + 5000).toISOString() };
      h.backend.sessions.set(id, shifted);
      return shifted;
    };
    await h.controller.start();
    await flush();
    const t = sdk.timing();
    expect(t.endsAt! - t.startedAt!).toBe(180_000);
    expect(t.deadlineAt! - t.endsAt!).toBe(30_000);
    expect(t.now() - h.clock.now()).toBe(5000);
    expect(t.remainingMs()).toBe(180_000);
  });

  it("backgrounding pauses presentation only: the deadline is not extended", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    const events: string[] = [];
    sdk.on("pause", () => events.push("pause"));
    sdk.on("resume", () => events.push("resume"));
    await readyAndStart(h, sdk);
    const deadline = sdk.timing().deadlineAt;
    h.controller.pause();
    await flush();
    expect(sdk.phase).toBe("paused");
    h.clock.advance(100_000);
    await h.controller.resume();
    await flush();
    expect(events).toEqual(["pause", "resume"]);
    expect(sdk.timing().deadlineAt).toBe(deadline);
    expect(sdk.timing().remainingMs()).toBe(80_000);
  });

  it("returning after the session ended elsewhere terminates the game instead of reviving it", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    const terminations: string[] = [];
    sdk.on("terminate", (t) => terminations.push(t.reason));
    await readyAndStart(h, sdk);
    h.controller.pause();
    await h.backend.api.cancelSession(sessionOf(h).sessionId); // e.g. cancelled from another tab
    await h.controller.resume();
    await flush();
    expect(terminations).toEqual(["session_ended"]);
    expect(h.controller.getState().phase).toBe("failed");
  });

  it("a result after the backend deadline is rejected as EXPIRED (the server decides)", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    await readyAndStart(h, sdk);
    h.controller.pause();
    h.clock.advance(211_000); // past limit + grace
    await h.controller.resume(); // still IN_PROGRESS on the server: no automatic expiry
    await flush();
    const outcome = await settle(h, sdk.submitResult({ score: 50 }));
    expect(outcome).toMatchObject({ status: "rejected", reason: "EXPIRED" });
    expect(sessionOf(h)).toMatchObject({ status: "ABANDONED", result: null });
  });
});

describe("start reliability", () => {
  it("reconciles a lost start response instead of failing", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    sdk.ready();
    await flush();
    h.backend.failNext("startSession", networkError(), true);
    await h.controller.start();
    await flush();
    expect(h.controller.getState().phase).toBe("playing");
    expect(sdk.phase).toBe("playing");
  });

  it("a start that did not happen lets the player retry", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    sdk.ready();
    await flush();
    h.backend.failNext("startSession", networkError(), false);
    await h.controller.start();
    expect(h.controller.getState()).toMatchObject({ phase: "ready", message: "Could not start. Try again." });
    await h.controller.start();
    await flush();
    expect(sdk.phase).toBe("playing");
  });
});

async function settle(h: ReturnType<typeof linkedHarness>, p: Promise<SubmitOutcome>): Promise<SubmitOutcome> {
  await flush(80);
  return p;
}

describe("result submission", () => {
  async function playing() {
    const h = linkedHarness();
    const sdk = await launch(h);
    await readyAndStart(h, sdk);
    return { h, sdk };
  }

  it("a lost response is reconciled: the stored result is confirmed, never sent twice into a second result", async () => {
    const { h, sdk } = await playing();
    h.backend.failNext("submitResult", networkError(), true);
    const outcome = await settle(h, sdk.submitResult({ score: 77 }));
    expect(outcome).toMatchObject({ status: "completed", score: 77 });
    expect(sessionOf(h).result).toEqual({ format: "SCORE_ATTACK", score: 77 });
  });

  it("a timeout is not a rejection: it retries the same submission and succeeds", async () => {
    const { h, sdk } = await playing();
    h.backend.failNext("submitResult", new PlatformApiError("timeout", null, null, "slow"));
    const outcome = await settle(h, sdk.submitResult({ score: 9 }));
    expect(outcome).toMatchObject({ status: "completed", score: 9 });
    expect(h.backend.count("submitResult")).toBe(2);
  });

  it("server errors (5xx) are retried, then reconciled", async () => {
    const { h, sdk } = await playing();
    h.backend.failNext("submitResult", httpError(500, "Internal", "INTERNAL"), true);
    const outcome = await settle(h, sdk.submitResult({ score: 12 }));
    expect(outcome).toMatchObject({ status: "completed", score: 12 });
  });

  it("an unreachable platform yields 'unresolved', and a later re-check delivers the final answer", async () => {
    const { h, sdk } = await playing();
    const results: SubmitOutcome[] = [];
    sdk.on("result", (o) => results.push(o));
    h.backend.down.add("submitResult");
    h.backend.down.add("getSession");
    const outcome = await settle(h, sdk.submitResult({ score: 300 }));
    expect(outcome.status).toBe("unresolved");
    expect(h.controller.getState().phase).toBe("unresolved");
    expect(h.backend.count("submitResult")).toBe(4);
    h.backend.down.clear();
    await h.controller.recheck();
    await flush(40);
    expect(results.map((r) => r.status)).toEqual(["unresolved", "completed"]);
    expect(sessionOf(h).result).toEqual({ format: "SCORE_ATTACK", score: 300 });
  });

  it("a re-check after an unconfirmed but stored submission does not submit again", async () => {
    const { h, sdk } = await playing();
    h.backend.failNext("submitResult", networkError(), true);
    h.backend.down.add("getSession");
    for (let i = 0; i < 3; i++) h.backend.failNext("submitResult", networkError(), false);
    expect((await settle(h, sdk.submitResult({ score: 5 }))).status).toBe("unresolved");
    h.backend.down.clear();
    const before = h.backend.count("submitResult");
    await h.controller.recheck();
    await flush(40);
    expect(h.controller.getState()).toMatchObject({ phase: "completed", outcome: { status: "completed", score: 5 } });
    // the retry is refused by the server (409, one result per session) and reconciliation confirms our score
    expect(h.backend.count("submitResult") - before).toBe(1);
  });

  it("maps definite refusals to rejection reasons", async () => {
    const cases: [number, string][] = [[400, "INVALID_RESULT"], [401, "UNAUTHENTICATED"], [403, "NOT_ALLOWED"], [404, "INVALID_SESSION"]];
    for (const [status, reason] of cases) {
      const { h, sdk } = await playing();
      h.backend.failNext("submitResult", httpError(status));
      const outcome = await settle(h, sdk.submitResult({ score: 1 }));
      expect(outcome, String(status)).toMatchObject({ status: "rejected", reason });
      expect(h.backend.count("submitResult")).toBe(1); // never retried
    }
  });

  it("one result per session: a different second result is refused locally and by the host", async () => {
    const { h, sdk } = await playing();
    const first = sdk.submitResult({ score: 10 });
    expect(sdk.submitResult({ score: 10 })).toBe(first); // idempotent
    await expect(sdk.submitResult({ score: 11 })).rejects.toMatchObject({ code: "DUPLICATE_SUBMISSION" });
    await settle(h, first);
    // A modified game bypassing the SDK sends another submission directly:
    const sid = sessionOf(h).sessionId;
    h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "submit", sessionId: sid,
      payload: { submissionId: "00000000-0000-4000-8000-0000000000aa", score: 999999, gameVersion: "1.0.0" } });
    await flush();
    expect(lastHostMessage(h)).toMatchObject({ type: "submit-result", payload: { outcome: { status: "rejected", reason: "ALREADY_SUBMITTED" } } });
    expect(h.backend.count("submitResult")).toBe(1);
    expect(sessionOf(h).result).toEqual({ format: "SCORE_ATTACK", score: 10 });
  });

  it("a different result already stored (e.g. another tab) is reported as ALREADY_SUBMITTED", async () => {
    const { h, sdk } = await playing();
    await h.backend.api.submitResult(sessionOf(h).sessionId, { format: "SCORE_ATTACK", score: 1 });
    const outcome = await settle(h, sdk.submitResult({ score: 2 }));
    expect(outcome).toMatchObject({ status: "rejected", reason: "ALREADY_SUBMITTED" });
  });

  it("rejects a result tagged with another game version", async () => {
    const { h } = await playing();
    h.fromGamePort({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "submit", sessionId: sessionOf(h).sessionId,
      payload: { submissionId: "00000000-0000-4000-8000-0000000000bb", score: 1, gameVersion: "9.9.9" } });
    await flush();
    expect(h.controller.getState().violations).toBe(1);
    expect(h.backend.count("submitResult")).toBe(0);
  });

  it("a submission made while paused is still accepted (the deadline decides, not visibility)", async () => {
    const { h, sdk } = await playing();
    h.controller.pause();
    await flush();
    const outcome = await settle(h, sdk.submitResult({ score: 3 }));
    expect(outcome.status).toBe("completed");
  });
});

describe("exit, termination and cleanup", () => {
  it("exiting mid-game ends the session through the normal cancel route (ABANDONED)", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    const terminations: string[] = [];
    sdk.on("terminate", (t) => terminations.push(t.reason));
    await readyAndStart(h, sdk);
    await h.controller.exit();
    await flush();
    expect(sessionOf(h).status).toBe("ABANDONED");
    expect(terminations).toEqual(["exit"]);
    expect(h.controller.getState().phase).toBe("closed");
  });

  it("exiting after a result was sent never cancels (the result may be stored)", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    await readyAndStart(h, sdk);
    h.backend.down.add("submitResult");
    h.backend.down.add("getSession");
    await settle(h, sdk.submitResult({ score: 8 }));
    await h.controller.exit();
    expect(h.backend.count("cancelSession")).toBe(0);
  });

  it("termination during submission resolves the game's promise as unresolved, not rejected", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    await readyAndStart(h, sdk);
    h.backend.down.add("submitResult");
    h.backend.down.add("getSession");
    const p = sdk.submitResult({ score: 8 });
    await flush(2);
    await h.controller.exit();
    expect(await settle(h, p)).toMatchObject({ status: "unresolved" });
  });

  it("dispose stops everything: later messages and late API answers are ignored", async () => {
    const h = linkedHarness();
    const sdk = await launch(h);
    sdk.ready();
    await flush();
    const pending = h.controller.start();
    h.controller.dispose();
    await pending;
    await flush();
    expect(h.controller.getState().phase).toBe("closed");
    const sent = h.hostReceived.length;
    h.fromGame({ garbage: true });
    expect(h.hostReceived.length).toBe(sent);
    sdk.dispose();
    expect((h.env as FakeGameEnv).listenerCount()).toBe(0);
    expect(() => sdk.on("start", () => undefined)).toThrow(SdkError);
  });
});

const HOST_LIKE_ORIGIN = "https://sabi.example";
