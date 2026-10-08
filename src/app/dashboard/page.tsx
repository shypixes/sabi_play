import { redirect } from "next/navigation";
import { logout } from "@/app/auth/actions";
import { getCurrentUser } from "@/server/auth";
import { getOwnProfile } from "@/server/profiles";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Defense in depth: middleware gates the route, the page verifies again.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const profile = await getOwnProfile(user.id);

  return (
    <>
      <h1>Dashboard</h1>
      <div className="card">
        <p>Signed in as <strong>{profile.display_name ?? user.email}</strong></p>
      </div>
      <form action={logout}><button type="submit" className="secondary">Log out</button></form>
    </>
  );
}
