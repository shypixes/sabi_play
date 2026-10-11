import Link from "next/link";
import { isLaunchable, type GameManifest } from "@/game-sdk";
import { Badge } from "@/components/ui";
import { gameTypeLabel } from "@/components/competitions/formats";

/**
 * Card for one integrated game, driven entirely by its validated GameManifest.
 * Games with a playable entry and Score Attack support link to free practice; others say
 * plainly that they can't be played yet instead of showing a button that does nothing.
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
        <p className="game-card__status">{game.metadata.description}</p>
        {isLaunchable(game) && game.formats.includes("SCORE_ATTACK") ? (
          <Link className="btn btn--sm game-card__action" href={`/games/${encodeURIComponent(game.id)}/play`}>
            Play practice
          </Link>
        ) : (
          <p className="game-card__status">Not playable yet.</p>
        )}
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
