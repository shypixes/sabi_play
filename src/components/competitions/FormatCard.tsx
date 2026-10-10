import { Icon } from "@/components/icons";
import { ComingSoonBadge } from "@/components/ui";
import type { CompetitionFormat } from "@/components/competitions/formats";

/**
 * Presents one competition format. Non-interactive until the competition system
 * exists; when it does, an entry action can be added here without changing pages.
 */
export function FormatCard({ format, compact = false }: { format: CompetitionFormat; compact?: boolean }) {
  return (
    <article className={`format-card format-card--${format.tone}${compact ? " format-card--compact" : ""}`}>
      <div className="format-card__top">
        <span className="format-card__icon"><Icon name={format.tone === "score" ? "bolt" : "swords"} size={compact ? 22 : 26} /></span>
        <ComingSoonBadge />
      </div>
      <h3 className="format-card__name">{format.name}</h3>
      <p className="format-card__tagline">{format.tagline}</p>
      {!compact && <p className="format-card__desc">{format.description}</p>}
      <dl className="format-card__facts">
        {format.facts.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
