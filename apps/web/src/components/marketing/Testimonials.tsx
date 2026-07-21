import { SectionHeading } from "./SectionHeading";
import { Stagger, StaggerItem } from "./Reveal";

/**
 * Social proof on the landing page.
 *
 * REAL QUOTES ONLY. This section renders NOTHING until there's at least one
 * genuine testimonial below — we don't ship fabricated reviews onto paid
 * traffic (conversion-integrity + FTC endorsement rules). To turn it back on,
 * add a real quote (with the person's permission): keep it short (one to three
 * sentences), attribute it first-name + role, and only add a card you can back
 * with a real person.
 *
 * Example shape (do NOT ship until it's a real person's words):
 *   { quote: "…", name: "Drick", role: "Barbershop owner" }
 */
const TESTIMONIALS: {
  quote: string;
  name: string;
  role: string;
}[] = [
  // Add real quotes here. Empty = the whole section is hidden.
];

export function Testimonials() {
  // No real testimonials yet → render nothing rather than fabricated proof.
  if (TESTIMONIALS.length === 0) return null;

  return (
    <section className="border-t border-subtle">
      <div className="mx-auto w-full max-w-6xl px-6 py-24">
        <SectionHeading
          eyebrow="From the chair"
          title="Owners keep it simple. So do we."
        />
        <Stagger className="mt-12 grid gap-5 md:grid-cols-3" gap={0.07}>
          {TESTIMONIALS.map((t) => (
            <StaggerItem key={t.name}>
              <figure className="glass flex h-full flex-col rounded-3xl p-7">
                <div className="flex gap-1 text-gold" role="img" aria-label="5 out of 5 stars">
                  {Array.from({ length: 5 }, (_, i) => (
                    <StarIcon key={i} className="h-4 w-4" />
                  ))}
                </div>
                <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-offwhite">
                  “{t.quote}”
                </blockquote>
                <figcaption className="mt-5 text-xs text-muted">
                  <span className="font-medium text-offwhite">{t.name}</span>
                  {" · "}
                  {t.role}
                </figcaption>
              </figure>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z" />
    </svg>
  );
}
