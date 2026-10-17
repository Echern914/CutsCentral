import type { SetupProgress } from "@chairback/config/onboarding";

/** Each step as a status, not an instruction: the owner is reading, not doing. */
const STATUS_LABEL: Record<SetupProgress["steps"][number]["id"], string> = {
  booking: "Booking method",
  team: "Who's bookable",
  services: "Services",
  hours: "Hours",
  clients: "Clients",
};

/**
 * How far one member's setup is, on the owner's Team page - so a shop moving
 * its whole team over (Luigi's, from Booksy) can see who's ready to take
 * bookings and who's stuck, without asking each of them.
 *
 * Yes/no per step, from the member's own data (config/onboarding.ts); never a
 * count, a client or a number. Shown unless the member hides it. `undefined`
 * is an older API that doesn't send it: nothing is shown.
 */
export function MemberSetup({ setup }: { setup: SetupProgress | null | undefined }) {
  if (setup === undefined) return null;
  if (setup === null) {
    return (
      <p className="mt-2 text-xs text-muted" data-qa="member-setup">
        Setup progress: hidden
      </p>
    );
  }
  if (setup.complete) {
    return (
      <p className="mt-2 text-xs text-emerald-soft" data-qa="member-setup">
        ✓ Set up - clients can book them
      </p>
    );
  }
  const required = setup.steps.filter((s) => s.id !== "clients");
  const done = required.filter((s) => s.done).length;
  return (
    <div className="mt-2" data-qa="member-setup">
      <p className="text-xs text-gold">
        Setting up · {done} of {required.length} done
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {setup.steps.map((s) => (
          <li
            key={s.id}
            className={
              s.done
                ? "rounded-full bg-emerald-soft/10 px-2 py-0.5 text-[11px] text-emerald-soft"
                : "rounded-full border border-subtle px-2 py-0.5 text-[11px] text-muted"
            }
          >
            <span aria-hidden="true">{s.done ? "✓ " : "○ "}</span>
            {STATUS_LABEL[s.id]}
            {s.id === "clients" && " (optional)"}
            <span className="sr-only">{s.done ? " (done)" : " (not yet)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
