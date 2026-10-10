import { Suspense } from "react";
import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { BalanceCard, BalanceCardSkeleton } from "@/components/wallet/BalanceCard";
import { FormatCard } from "@/components/competitions/FormatCard";
import { COMPETITION_FORMATS } from "@/components/competitions/formats";
import { GameGrid } from "@/components/games/GameCard";
import { Icon } from "@/components/icons";
import { EmptyState, SectionHeader } from "@/components/ui";
import { SignOutButton } from "@/components/SignOutButton";
import { listAvailableGames } from "@/games/registry";
import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/server/auth";
import { findOwnProfile, playerName } from "@/server/profiles";
import type { Profile } from "@/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

export default async function DashboardPage() {
  // Defense in depth: middleware gates the route, the page verifies again.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let profile: Profile | null = null;
  try {
    profile = await findOwnProfile(user.id);
  } catch (err) {
    unstable_rethrow(err);
    // The greeting falls back to a generic name; the rest of the page still works.
    logger.error("dashboard profile load failed", { action: "dashboard.profile", userId: user.id }, err);
  }
  const name = playerName(profile) ?? "Player";
  const games = listAvailableGames();

  return (
    <div className="stack-lg">
      <section className="hero">
        <p className="eyebrow">Welcome back</p>
        <h1 className="hero__title">Hey, <span className="accent-text">{name}</span></h1>
        <p className="hero__sub">Your home for quick, competitive games.</p>
      </section>

      <Suspense fallback={<BalanceCardSkeleton />}>
        <BalanceCard userId={user.id} />
      </Suspense>

      <section aria-labelledby="home-games" className="stack">
        <SectionHeader id="home-games" title="Games" action={{ href: "/games", label: "All games" }} />
        <Link href="/games" className="promo-card">
          <span className="promo-card__icon"><Icon name="games" size={28} /></span>
          <span className="promo-card__text">
            <strong>Browse games</strong>
            <span>See what&apos;s playable and what&apos;s on the way.</span>
          </span>
          <Icon name="arrow-right" size={20} />
        </Link>
        {games.length > 0 ? (
          <GameGrid games={games} />
        ) : (
          <EmptyState icon="games" title="Games are coming soon" compact>
            We&apos;re building the first Sabi Play games. They&apos;ll show up here as soon as they&apos;re ready.
          </EmptyState>
        )}
      </section>

      <section aria-labelledby="home-competitions" className="stack">
        <SectionHeader id="home-competitions" title="Competitions" action={{ href: "/competitions", label: "Learn more" }} />
        <div className="format-grid">
          {COMPETITION_FORMATS.map((f) => <FormatCard key={f.type} format={f} compact />)}
        </div>
      </section>

      <div className="home-signout">
        <SignOutButton />
      </div>
    </div>
  );
}
