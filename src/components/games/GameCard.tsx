import type { GameManifest } from "@/game-sdk";
import { Badge } from "@/components/ui";
import { gameTypeLabel } from "@/components/competitions/formats";

/**
 * Card for one integrated game, driven entirely by its validated GameManifest.
 * There is no launch control yet: launching requires the Game SDK runtime, so the
 * card states that plainly instead of showing a button that does nothing.
 */
export function GameCard({ game }: { game: GameManifest }) {
  const initials = game.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const tone = game.formats.length === 1 && game.formats[0] === "ONE_V_ONE" ? "duel" : "score";
  return (
    <article className="game-card">
      <div className={`game-card__art game-card__art--${tone}`} aria-hidden="true">
        {initials}
      </div>
      <div className="game-card__body">
        <h3>{game.name}</h3>
        <div className="game-card__meta">
          {game.formats.map((f) => <Badge key={f}>{gameTypeLabel(f)}</Badge>)}
        </div>
        <p className="game-card__status">Launching opens with the Game SDK.</p>
      </div>
    </article>
  );
}

export function GameGrid({ games }: { games: readonly GameManifest[] }) {
  return (
    <div className="game-grid">
      {games.map((g) => <GameCard key={g.id} game={g} />)}
    </div>
  );
}
