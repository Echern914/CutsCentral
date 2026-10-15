"use client";

import { useState } from "react";

/**
 * Which services a seat may make offers for (Offers & codes). Owners and
 * managers can make any offer; a provider seat only for the services ticked
 * here, and only on their own chair - the API enforces both (routes/offers.ts).
 * Shown only while the shop has Offers & codes switched on.
 */
export function MemberOffers({
  name,
  stationNoun,
  services,
  allowed,
  pending,
  onSave,
}: {
  name: string;
  /** The shop's word for a chair (vocabulary). */
  stationNoun: string;
  services: { id: string; name: string }[];
  allowed: string[];
  pending: boolean;
  onSave: (serviceIds: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>(allowed);
  // A service since switched off is still in the saved list; say only live ones.
  const names = services.filter((s) => allowed.includes(s.id)).map((s) => s.name);

  if (!editing) {
    return (
      <p className="mt-0.5 text-xs text-muted" data-testid="member-offers">
        {names.length > 0 ? `Can make offers for ${names.join(", ")}` : "Can't make offers"}
        {" · "}
        <button
          type="button"
          onClick={() => {
            setPicked(allowed);
            setEditing(true);
          }}
          disabled={pending}
          className="text-gold underline-offset-4 hover:underline disabled:opacity-50"
          aria-label={`Change which offers ${name} can make`}
        >
          Change
        </button>
      </p>
    );
  }

  return (
    <fieldset className="mt-2 space-y-2 rounded-xl border border-subtle p-3" data-testid="member-offers-edit">
      <legend className="px-1 text-xs text-muted">Offers {name} can make, on their own {stationNoun}</legend>
      {services.length === 0 ? (
        <p className="text-xs text-muted">Add a service first.</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {services.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-xs text-offwhite">
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((id) => id !== s.id)))
                }
              />
              {s.name}
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => {
            onSave(picked);
            setEditing(false);
          }}
          disabled={pending}
          className="rounded-full bg-gold px-3 py-1 text-xs font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={pending}
          className="text-xs text-muted hover:text-offwhite"
        >
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
