import { notFound } from "next/navigation";
import { isLaunchable } from "@/game-sdk";
import { GAMES, findGame } from "@/games/registry";
import { GameFrame } from "./GameFrame";

/**
 * The game container document. Loaded ONLY inside the platform's sandboxed iframe
 * (sandbox="allow-scripts", so it runs with an opaque origin: no cookies, no storage, no access
 * to the platform page) and served with a strict CSP from next.config.ts (no network access,
 * embeddable only by this site). It contains no user data and needs no authentication.
 */
export const metadata = { title: "Game", robots: { index: false, follow: false } };

/** Launchable games are prerendered; any other id renders notFound() (404). */
export function generateStaticParams(): { gameId: string }[] {
  return GAMES.filter(isLaunchable).map((g) => ({ gameId: g.id }));
}

export default async function GameFramePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const game = findGame(gameId);
  if (!game || !isLaunchable(game)) notFound();
  return <GameFrame manifest={game} />;
}
