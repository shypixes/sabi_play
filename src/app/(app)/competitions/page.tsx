import { redirect } from "next/navigation";
import { FormatCard } from "@/components/competitions/FormatCard";
import { COMPETITION_FORMATS } from "@/components/competitions/formats";
import { EmptyState, PageHeader, SectionHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Competitions" };

export default async function CompetitionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow="Compete"
        title="Competitions"
        intro="Sabi Play launches with two competition formats. Both are being built now."
      />

      <section aria-labelledby="formats" className="stack">
        <SectionHeader id="formats" title="Formats" />
        <div className="format-grid">
          {COMPETITION_FORMATS.map((f) => <FormatCard key={f.type} format={f} />)}
        </div>
      </section>

      <section aria-labelledby="live" className="stack">
        <SectionHeader id="live" title="Open competitions" />
        <EmptyState icon="trophy" title="No competitions open yet">
          Competitions will open once the first games and the competition system go live. Check back soon.
        </EmptyState>
      </section>
    </div>
  );
}
