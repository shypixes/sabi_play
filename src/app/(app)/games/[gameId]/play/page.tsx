import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { GameHost } from "@/components/games/GameHost";
import { EmptyState, PageHeader, SectionError } from "@/components/ui";
import { findLaunchableGame } from "@/games/registry";
import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/server/auth";
import { listCompetitionOptions } from "@/server/competitions";
import type { CompetitionOption } from "@/game-sdk";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ gameId: string }> };

export async function generateMetadata({ params }: Params) {
  const { gameId } = await params;
  return { title: findLaunchableGame(gameId, "SCORE_ATTACK")?.name ?? "Play" };
}

/** Free-practice launcher for one game. Only enabled PRACTICE Score Attack configs can be played. */
export default async function PlayGamePage({ params }: Params) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { gameId } = await params;
  const game = findLaunchableGame(gameId, "SCORE_ATTACK");
  if (!game) notFound();

  let practice: CompetitionOption | undefined;
  let loadFailed = false;
  try {
    const options = await listCompetitionOptions({ gameId: game.id, format: "SCORE_ATTACK" });
    practice = options.find((o) => o.mode === "PRACTICE" && o.entryFee === 0);
  } catch {
    logger.error("Could not load practice configs", { action: "games.play" });
    loadFailed = true;
  }

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Free practice" title={game.name} intro={game.metadata.howToPlay} />
      {loadFailed ? (
        <SectionError title="Couldn't load this game" retryHref={`/games/${game.id}/play`} />
      ) : !practice ? (
        <EmptyState icon="games" title="Practice isn't open yet" action={{ href: "/games", label: "Back to games" }}>
          Free practice for {game.name} hasn&apos;t been switched on yet. Check back soon.
        </EmptyState>
      ) : (
        <GameHost
          launch={{
            gameId: game.id,
            gameVersion: game.version,
            configId: practice.configId,
            timeLimitSeconds: practice.timeLimitSeconds,
            gameConfig: game.gameConfig,
          }}
          gameName={game.name}
          orientations={game.orientations}
          capabilities={game.capabilities}
        />
      )}
      <p className="fine-print">
        Practice scores are submitted by your device and stored as unverified. They don&apos;t count toward rewards. <Link className="text-link" href="/games">All games</Link>
      </p>
    </div>
  );
}
