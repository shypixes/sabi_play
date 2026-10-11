import { redirect } from "next/navigation";
import { GameGrid } from "@/components/games/GameCard";
import { Icon } from "@/components/icons";
import { ComingSoonBadge, EmptyState, PageHeader, SectionHeader } from "@/components/ui";
import { listAvailableGames } from "@/games/registry";
import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Games" };

const UPCOMING = [
  { icon: "bolt", title: "Score Attack modes", text: "Three-minute sessions where your best score counts." },
  { icon: "swords", title: "1v1 modes", text: "Games that pit you directly against another player." },
] as const;

export default async function GamesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const games = listAvailableGames();

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow="Play"
        title="Games"
        intro="Discover and launch Sabi Play games. Every game plugs into the same platform, so new titles appear here as they're released."
      />

      <section aria-labelledby="games-available" className="stack">
        <SectionHeader id="games-available" title="Available now" />
        {games.length > 0 ? (
          <GameGrid games={games} />
        ) : (
          <EmptyState icon="games" title="No games available yet" action={{ href: "/competitions", label: "Explore competition formats" }}>
            The first Sabi Play games are in development. When a game is ready to play, it will appear right here.
          </EmptyState>
        )}
      </section>

      <section aria-labelledby="games-upcoming" className="stack">
        <SectionHeader id="games-upcoming" title="On the way" />
        <ul className="feature-list">
          {UPCOMING.map((f) => (
            <li key={f.title} className="feature-list__item">
              <span className="feature-list__icon"><Icon name={f.icon} size={20} /></span>
              <div>
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </div>
              <ComingSoonBadge />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
