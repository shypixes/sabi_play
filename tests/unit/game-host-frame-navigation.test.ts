import { describe, expect, it } from "vitest";
import { MESSAGE_CHANNEL, PROTOCOL_VERSION, type GameSdk } from "@/game-sdk";
import { flush, linkedHarness } from "../helpers/game-fakes";

// UNIT (MOCKED backend): the REAL GameHostController and REAL SDK client through fake windows.
// Security property (F2): once the game iframe holds a second document (navigation or reload),
// the host stops trusting it, stops posting to it, and ends an unfinished attempt. Two signals:
// a second load event, and (independent of load timing) any protocol message on the frame
// WINDOW after the handshake, because the real game document talks only over its private port.

type H = ReturnType<typeof linkedHarness>;

async function launched(h: H): Promise<GameSdk> {
  await h.controller.createSession();
  h.controller.frameLoaded(); // the platform's game document
  const sdk = await h.connect();
  await flush();
  return sdk;
}

async function playing(h: H): Promise<GameSdk> {
  const sdk = await launched(h);
  sdk.ready();
  await flush();
  await h.controller.start();
  await flush();
  expect(h.controller.getState().phase).toBe("playing");
  return sdk;
}

const session = (h: H) => h.backend.sessions.get(h.controller.getState().session!.sessionId)!;
const forgedSubmit = (h: H, score = 999_999) => ({
  channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "submit", sessionId: session(h).sessionId,
  payload: { submissionId: "00000000-0000-4000-8000-0000000000e1", score, gameVersion: "1.0.0" },
});

describe("game frame navigation (F2)", () => {
  it("treats the first load as the game document: normal init and play are unaffected", async () => {
    const h = linkedHarness();
    const sdk = await playing(h);
    expect(h.controller.getState().frameRevoked).toBe(false);
    h.clock.advance(180_000);
    const outcome = await sdk.submitResult({ score: 42 });
    expect(outcome.status).toBe("completed");
    expect(session(h).result).toEqual({ format: "SCORE_ATTACK", score: 42 });
  });

  it("navigation while READY: revokes the frame, cancels the session, ignores the new document", async () => {
    const h = linkedHarness();
    await launched(h);
    const posted = h.hostReceived.length;
    h.controller.frameLoaded(); // second document in the frame
    await flush();
    const state = h.controller.getState();
    expect(state.frameRevoked).toBe(true);
    expect(state.phase).toBe("failed");
    expect(state.message).toMatch(/left its frame/);
    expect(session(h).status).toBe("CANCELLED");
    // Nothing is sent to the new document, and nothing from it is accepted.
    expect(h.hostReceived.length).toBe(posted);
    h.fromGame({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "ready", sessionId: session(h).sessionId, payload: {} });
    await flush();
    expect(h.controller.getState().phase).toBe("failed");
    expect(h.controller.getState().violations).toBe(0); // dropped before any processing
    expect(h.hostReceived.length).toBe(posted);
    // Start is impossible afterwards.
    await h.controller.start();
    expect(h.backend.count("startSession")).toBe(0);
  });

  it("navigation while playing (no result yet): abandons the session and refuses a later forged result", async () => {
    const h = linkedHarness();
    await playing(h);
    const posted = h.hostReceived.length;
    h.controller.frameLoaded();
    await flush();
    expect(h.controller.getState().phase).toBe("failed");
    expect(session(h).status).toBe("ABANDONED");
    h.fromGame(forgedSubmit(h));
    await flush();
    expect(h.backend.count("submitResult")).toBe(0);
    expect(session(h).result).toBeNull();
    expect(h.hostReceived.length).toBe(posted);
  });

  it("navigation while a result is being delivered: delivery completes, nothing is posted to the frame", async () => {
    const h = linkedHarness();
    const sdk = await playing(h);
    h.clock.advance(180_000);
    void sdk.submitResult({ score: 77 });
    // Let the submit message reach the host, then navigate before the backend answers.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.controller.getState().phase).toBe("submitting");
    const posted = h.hostReceived.length;
    h.controller.frameLoaded();
    await flush();
    const state = h.controller.getState();
    expect(state.frameRevoked).toBe(true);
    expect(state.phase).toBe("completed");
    expect(state.outcome).toMatchObject({ status: "completed", score: 77 });
    expect(session(h).status).toBe("COMPLETED");
    expect(h.backend.count("cancelSession")).toBe(0);
    expect(h.hostReceived.length).toBe(posted); // the outcome was not sent to the new document
  });

  it("navigation after completion: only drops the frame (no cancel, outcome kept)", async () => {
    const h = linkedHarness();
    const sdk = await playing(h);
    h.clock.advance(180_000);
    await sdk.submitResult({ score: 5 });
    h.controller.frameLoaded();
    await flush();
    const state = h.controller.getState();
    expect(state.frameRevoked).toBe(true);
    expect(state.phase).toBe("completed");
    expect(state.outcome).toMatchObject({ status: "completed", score: 5 });
    expect(h.backend.count("cancelSession")).toBe(0);
  });

  it("a reload of the game document is also a navigation (and the revocation survives re-attaching)", async () => {
    const h = linkedHarness();
    await launched(h);
    h.controller.frameLoaded();
    h.controller.frameLoaded(); // further loads change nothing
    await flush();
    expect(h.backend.count("cancelSession")).toBe(1);
    // The UI re-attaching its channel must not restore trust.
    h.controller.attachFrame({ post: () => { throw new Error("must not post"); }, openChannel: () => { throw new Error("must not open a channel"); }, isFromGame: () => true });
    h.fromGame({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "hello", sessionId: null, payload: { sdkVersion: "1.0.0", gameId: "pop-rush", gameVersion: "1.0.0" } });
    await h.controller.exit(); // posts terminate: must be dropped, not thrown
    expect(h.controller.getState().phase).toBe("closed");
  });

  describe("document-bound channel (no load event needed)", () => {
    it("a forged submit on the frame window during play is never acted on: revoke + ABANDONED", async () => {
      const h = linkedHarness();
      await playing(h);
      const posted = h.hostReceived.length;
      // The new document posts before (or without) its load event, e.g. a page that stalls loading.
      h.fromGame(forgedSubmit(h));
      await flush();
      expect(h.backend.count("submitResult")).toBe(0);
      expect(h.controller.getState()).toMatchObject({ phase: "failed", frameRevoked: true });
      expect(session(h)).toMatchObject({ status: "ABANDONED", result: null });
      expect(h.hostReceived.length).toBe(posted); // not even an error reply to the new document
    });

    it("a forged ready on the frame window while loading revokes and cancels", async () => {
      const h = linkedHarness();
      await launched(h);
      h.fromGame({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "ready", sessionId: session(h).sessionId, payload: {} });
      await flush();
      expect(h.controller.getState()).toMatchObject({ phase: "failed", frameRevoked: true });
      expect(session(h).status).toBe("CANCELLED");
    });

    it("after revocation the old channel is closed: host messages stop and old-document messages are dropped", async () => {
      const h = linkedHarness();
      const sdk = await playing(h);
      h.fromGame(forgedSubmit(h));
      await flush();
      expect(h.env.hostPort?.closed).toBe(true);
      const posted = h.hostReceived.length;
      void sdk.submitResult({ score: 5 }).catch(() => undefined);
      h.fromGamePort(forgedSubmit(h, 7));
      h.controller.pause();
      await flush();
      expect(h.backend.count("submitResult")).toBe(0);
      expect(h.hostReceived.length).toBe(posted);
    });

    it("non-protocol window noise from the frame does not revoke (and is not acted on)", async () => {
      const h = linkedHarness();
      const sdk = await playing(h);
      h.fromGame({ some: "devtools noise" });
      h.fromGame("ping");
      await flush();
      expect(h.controller.getState()).toMatchObject({ phase: "playing", frameRevoked: false, violations: 0 });
      expect((await sdk.submitResult({ score: 3 })).status).toBe("completed");
    });

    it("a frame that cannot receive the channel ends the attempt (host_error) and releases the session", async () => {
      const h = linkedHarness();
      await h.controller.createSession();
      h.controller.attachFrame({ post: () => undefined, openChannel: () => null, isFromGame: (m) => m.source === h.frameWindow });
      h.fromGame({ channel: MESSAGE_CHANNEL, protocol: PROTOCOL_VERSION, type: "hello", sessionId: null,
        payload: { sdkVersion: "1.0.0", gameId: "pop-rush", gameVersion: "1.0.0" } });
      await flush();
      expect(h.controller.getState()).toMatchObject({ phase: "failed", message: "Could not open a channel to the game." });
      expect(session(h).status).toBe("CANCELLED");
    });
  });
});
