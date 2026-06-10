import { Reveal } from "./Reveal";

/** Consistent section opener: gold eyebrow chip, display title, muted sub. */
export function SectionHeading({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: string;
}) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold-soft">
        <span className="h-1.5 w-1.5 rounded-full bg-gold" />
        {eyebrow}
      </p>
      <h2 className="mt-5 font-display text-3xl tracking-tight sm:text-5xl">
        {title}
      </h2>
      {sub && <p className="mt-4 text-base leading-relaxed text-muted">{sub}</p>}
    </Reveal>
  );
}
