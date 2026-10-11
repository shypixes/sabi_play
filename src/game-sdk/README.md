# Sabi Play Game SDK v1

`SDK_VERSION = "1.0.0"`, `PROTOCOL_VERSION = 1` (`version.ts`).

Games import ONLY from `@/game-sdk` and their own folder (`tests/unit/boundaries.test.ts` enforces
this). They never import `@/server`, `@/lib/*`, Supabase, wallets or payments, and never call an
HTTP endpoint: the game frame has no network access at all.

Who owns what:
- **Platform:** auth, catalog, configs and sessions, the official clock, result acceptance,
  validation, wallets and settlement.
- **SDK:** the typed contract. That covers session context, lifecycle, timing, result submission,
  errors, compatibility and cleanup.
- **Game:** rendering, input, physics, scoring and audio. Use any engine, or none.

## Writing a game

```ts
// src/games/my-game/game.ts
import { defineGame } from "@/game-sdk";

export default defineGame({
  mount(root, sdk) {
    // Load assets here; loading never starts a round.
    const off = [
      sdk.on("start", (timing) => { /* begin; show timing.remainingMs() */ }),
      sdk.on("pause", () => { /* stop animating; the official clock keeps running */ }),
      sdk.on("resume", (timing) => { /* re-sync to timing.remainingMs() */ }),
      sdk.on("terminate", (info) => { /* stop; the platform ended the attempt */ }),
    ];
    sdk.ready(); // once, after handlers are registered
    // When timing.remainingMs() reaches 0:
    //   const outcome = await sdk.submitResult({ score });
    return { dispose() { off.forEach((f) => f()); /* remove your own listeners/timers */ } };
  },
});
```

The platform's frame (`src/app/game-frame/[gameId]`) calls `connectToPlatform({ manifest })`, loads
the entry module through `src/games/loaders.ts`, calls `mount`, and disposes both on `pagehide`.
Games do not call `connectToPlatform` themselves.

## Public interface (`client.ts`)

| Member | Behaviour |
|---|---|
| `version` | The SDK version the game was built with. |
| `context` | A read-only `SessionContext`, described below. |
| `phase` | One of `connected`, `ready`, `playing`, `paused`, `submitting`, `finished`, `terminated`, `disposed`. |
| `ready()` | Tells the platform that assets are loaded. The host then shows Start. |
| `on(event, fn)` | Subscribes to `start`, `pause`, `resume`, `terminate` or `result`. Returns an unsubscribe function. |
| `timing()` | Returns `OfficialTiming`: `startedAt`, `endsAt`, `deadlineAt`, `now()` and `remainingMs()`, all on the **server** clock. |
| `submitResult({score})` | Resolves with a `SubmitOutcome` (below). It is idempotent for the same score. Rejects only on misuse. |
| `reportError(code, msg, {fatal})` | Reports an error to the host. `fatal` ends the attempt. |
| `exit()` | Asks the host to close the game. |
| `dispose()` | Removes every SDK listener and timer. It is safe to call more than once. |

**`SessionContext`** contains `sessionId`, `gameId`, `gameVersion`, `format`, `mode`
(PRACTICE/PAID), `status`, `gameConfig` (from the manifest), `timing` and
`sdk {hostVersion, protocol}`. There is no user id, email, wallet, token or other player's data.

**`SubmitOutcome`** takes one of four forms:
- `completed`: the backend stored the result. Practice results are always `UNVERIFIED` /
  `NOT_REQUIRED`.
- `pending_verification`: for paid sessions, which are disabled in v1.
- `rejected`: carries a `reason` (`EXPIRED`, `ALREADY_SUBMITTED`, `INVALID_RESULT`,
  `INVALID_SESSION`, `NOT_ALLOWED` or `UNAUTHENTICATED`) and a safe `message`.
- `unresolved`: the platform could not confirm the result, for example because the connection was
  lost. This is **not** a rejection. The host keeps reconciling, and a later `result` event delivers
  the final answer.

**`SdkError` codes:** `NOT_IN_FRAME`, `INVALID_MANIFEST`, `INCOMPATIBLE`, `WRONG_GAME`,
`SESSION_NOT_PLAYABLE`, `HOST_TIMEOUT`, `INVALID_STATE`, `INVALID_SCORE`,
`DUPLICATE_SUBMISSION` and `DISPOSED`.

**Scores** must be non-negative safe integers no greater than 1e12 (`MAX_SCORE`, `isValidScore`).
The client score is never trusted. Practice results stay UNVERIFIED and never touch a wallet.

## Lifecycle and timing (Score Attack)

The full sequence is: frame loads → `hello` → host sends context → manifest, game id and SDK
compatibility checks → `ready()` → the player taps Start → the host calls
`POST /api/competitions/sessions/{id}/start` → `start` event → play → `submitResult` (or
`terminate`) → `dispose`.

- **Who starts the round:** only the platform can, after the server has started the session.
  A `start` message from anywhere else is ignored.
- **Clock:** time comes from the server's `started_at`. The host estimates the device's clock
  offset around the start request, so a wrong device clock does not change the round length.
- **Gameplay length:** `endsAt = startedAt + 180s`. The backend accepts results until
  `deadlineAt = endsAt + 30s` of grace.
- **Pause and backgrounding:** pausing is presentational only. Hiding the page sends `pause` and
  showing it sends `resume`. Neither extends the deadline. On resume the host re-reads the session
  from the server, and a session that is no longer IN_PROGRESS terminates the game. If the
  gameplay time ran out while hidden, `remainingMs()` is 0 and the game submits at once. The
  server accepts that result only before `deadlineAt`. After that it refuses with `EXPIRED` and
  marks the session ABANDONED, so returning never revives an expired round.
- **One result per session:** a second, different score fails with `DUPLICATE_SUBMISSION`, and the
  backend refuses it anyway with 409. Each new attempt is a new session ("Play again").
- **No automatic expiry:** the backend has none. An unsubmitted session is ABANDONED when the
  player exits, or by the lazy check when a result arrives after the deadline. The client does not
  fake expiry with timers.

## Manifest (`manifest.ts`, schema version 1)

These fields are required: `schemaVersion: 1`, `id` (stable, lowercase), `name`, `version` (semver),
`status` (DRAFT/ACTIVE/DISABLED), `entry` (a `.ts` file, or `null` if the game is not launchable),
`sdk {min, maxExclusive}`, `formats`, `inputs` (touch/pointer/keyboard), `orientations`,
`capabilities`, `metadata {description, howToPlay}` and `gameConfig` (at most 16 small scalar
entries). Unknown keys are rejected.

**Rejected manifests:**
- Any manifest that sets a platform-owned key (fees, rewards, time limits, mode, player counts,
  validation, wallet).
- Any capability that is forbidden or unknown. Only `audio` and `fullscreen` exist, and they
  delegate only `autoplay` and `fullscreen`.
- Any game whose SDK range excludes `SDK_VERSION`.
- Duplicate ids. `registerGames` throws `ManifestError` with actionable messages; the build fails
  rather than silently overwriting.

Platform settings such as fee, time limit and mode live in `competition_configs`, not in the
manifest.

## Protocol (`protocol.ts`, for platform code)

Each message uses the envelope `{channel: "sabi-play.game", protocol: 1, type, sessionId, payload}`,
validated strictly with zod and capped at 4096 bytes.
- **Host → game:** `init`, `start`, `pause`, `resume`, `terminate`, `submit-result`, `error`.
- **Game → host:** `hello`, `ready`, `submit {submissionId, score, gameVersion}`, `error {fatal}`,
  `exit`.

Each side accepts messages only from the expected window. The game frame has an opaque `"null"`
origin, and the host checks that origin. Messages are also checked for session id, protocol version
and an allowed sequence. Anything else is dropped, and the host terminates the game after 10
violations.
