Games. Each game lives in `src/games/<id>/` with a `manifest.ts` (schema v1, validated by
`registerGames` in `@/game-sdk`) and an entry module exporting `defineGame({ mount })`.
Games may import ONLY from `@/game-sdk` and their own folder; they run inside a sandboxed
iframe and talk to the platform only through the SDK. See `src/game-sdk/README.md`.

Add a game: create the folder, add the manifest to `registry.ts` and the loader to `loaders.ts`,
then create a disabled practice config for its id in `public.competition_configs` and enable it.

- `pop-rush/`: reference game (Canvas 2D).
- `sum-sprint/`: minimal second game (DOM) proving the SDK is reusable.
- `test-game/`: TEMPORARY, non-playable entry for /test-panel; remove before launch.
