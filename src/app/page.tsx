import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { COMPETITION_FORMATS } from "@/components/competitions/formats";

export default function Home() {
  return (
    <main className="public-shell landing">
      <BrandMark size="lg" />
      <section className="landing__hero">
        <h1>Play sharp. <span className="accent-text">Compete smarter.</span></h1>
        <p>Quick, skill-based games built for your phone. Competitive formats are on the way.</p>
        <div className="landing__actions">
          <Link href="/signup" className="btn">Create account</Link>
          <Link href="/login" className="btn btn--ghost">Log in</Link>
        </div>
      </section>
      <ul className="landing__formats" aria-label="Planned competition formats">
        {COMPETITION_FORMATS.map((f) => (
          <li key={f.type} className={`landing__format landing__format--${f.tone}`}>
            <Icon name={f.tone === "score" ? "bolt" : "swords"} size={20} />
            <div>
              <strong>{f.name}</strong>
              <span>{f.tagline}</span>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
