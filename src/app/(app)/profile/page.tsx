import { redirect, unstable_rethrow } from "next/navigation";
import { Badge, PageHeader, SectionError, SectionHeader } from "@/components/ui";
import { SignOutButton } from "@/components/SignOutButton";
import { APP_TIME_ZONE } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/server/auth";
import { findOwnProfile, playerName } from "@/server/profiles";
import type { Profile } from "@/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profile" };

const dateFormat = new Intl.DateTimeFormat("en-NG", { dateStyle: "long", timeZone: APP_TIME_ZONE });

export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let profile: Profile | null = null;
  let profileFailed = false;
  try {
    profile = await findOwnProfile(user.id);
  } catch (err) {
    unstable_rethrow(err);
    profileFailed = true;
    logger.error("profile load failed", { action: "profile.get", userId: user.id }, err);
  }

  const name = playerName(profile) ?? "Player";
  const initial = (Array.from(profile?.display_name ?? profile?.username ?? user.email ?? "P")[0] ?? "P").toUpperCase();
  const memberSince = profile?.created_at ?? user.created_at;

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Account" title="Profile" />

      <section className="profile-hero" aria-label="Player">
        <span className="avatar" aria-hidden="true">{initial}</span>
        <div>
          <p className="profile-hero__name">{name}</p>
          <p className="profile-hero__handle">{profile?.username ? `@${profile.username}` : "No username yet"}</p>
        </div>
      </section>

      {profileFailed && <SectionError title="We couldn't load your profile details." retryHref="/profile" />}

      <section aria-labelledby="details" className="stack">
        <SectionHeader id="details" title="Account details" />
        <dl className="detail-list">
          <div>
            <dt>Display name</dt>
            <dd>{profile?.display_name ?? <span className="muted">Not set</span>}</dd>
          </div>
          <div>
            <dt>Username</dt>
            <dd>{profile?.username ? `@${profile.username}` : <span className="muted">Not set</span>}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd className="detail-list__email">
              {user.email ?? <span className="muted">Not available</span>}
              {user.email && (user.email_confirmed_at
                ? <Badge tone="success">Verified</Badge>
                : <Badge tone="warning">Unverified</Badge>)}
            </dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{dateFormat.format(new Date(memberSince))}</dd>
          </div>
        </dl>
        <p className="fine-print">Editing your display name and username is coming in a later update.</p>
      </section>

      <section aria-labelledby="actions" className="stack">
        <SectionHeader id="actions" title="Account actions" />
        <SignOutButton />
      </section>
    </div>
  );
}
