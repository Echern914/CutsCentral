"use client";

import { useState } from "react";
import {
  BUSINESS_TYPES,
  SELECTABLE_BUSINESS_TYPE_IDS,
  type BusinessTypeId,
} from "@chairback/config/businessTypes";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { saveBusinessTypeAction } from "../actions";

/**
 * What kind of business this is - and, for a shop that has never been asked, the
 * one-time prompt that asks.
 *
 * Two states, one component, because they are the same question:
 *  - `selected: false` => a shop predating the picker. It renders NEUTRAL
 *    wording everywhere until someone answers, and this card leads with the
 *    question rather than burying it in settings.
 *  - `selected: true`  => a normal editable setting.
 *
 * 🔴 The prompt NEVER blocks. No modal, no interstitial, no redirect. A shop
 * that ignores it keeps booking, texting and taking payments exactly as before,
 * just in neutral words - which is the whole point of having a neutral
 * vocabulary rather than guessing. Staff seats do not see it at all: only an
 * OWNER or MANAGER can answer, and offering a button that will 403 is worse
 * than offering nothing.
 */
export function BusinessTypeCard({
  current,
  selected,
  canEdit,
}: {
  /** The stored id. For an unselected shop this is a DEFAULT, not an answer. */
  current: string;
  selected: boolean;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  // Explicit pending state rather than useTransition: the save is a plain async
  // round trip, and passing an async function to startTransition does not
  // typecheck under this React version's types.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pre-highlight the stored guess for an unselected shop, but do not treat it
  // as an answer - the owner still has to press Save.
  const [choice, setChoice] = useState<BusinessTypeId | "">(
    selected && isKnown(current) ? current : "",
  );

  if (!canEdit) return null;

  async function save() {
    if (!choice) {
      setError("Pick the option that fits best.");
      return;
    }
    setPending(true);
    try {
      const res = await saveBusinessTypeAction(choice);
      if (!res.ok) {
        setError("Could not save that. Try again.");
        toast("Could not save your business type", "error");
        return;
      }
      setError(null);
      toast("Business type saved", "success");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={selected ? "Business type" : "What kind of business is this?"}
        subtitle={
          selected
            ? "Sets the words ChairBack uses for your team, workspaces and visits."
            : "You set this shop up before we started asking. Tell us and ChairBack will use your industry's words instead of generic ones."
        }
      />
      <div className="flex flex-col gap-4 px-5 py-5">
        <div
          role="radiogroup"
          aria-label="Business type"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {SELECTABLE_BUSINESS_TYPE_IDS.map((id) => {
            const t = BUSINESS_TYPES[id];
            const active = choice === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setChoice(id)}
                // min-h-11 keeps every card at the existing touch-target floor.
                className={cn(
                  "flex min-h-11 w-full min-w-0 items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors duration-150 ease-out",
                  active
                    ? "border-gold/60 bg-gold/10"
                    : "border-subtle bg-charcoal-700 hover:bg-charcoal-600",
                )}
              >
                <span aria-hidden className="text-lg leading-none">
                  {t.emoji}
                </span>
                {/* min-w-0 is load-bearing: without it the flex child refuses to
                    shrink and the tagline pushes the card into a horizontal
                    scroll on a narrow phone. */}
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-offwhite">{t.label}</span>
                  <span className="block text-xs leading-snug text-muted">{t.tagline}</span>
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-[11px] leading-relaxed text-muted/80">
          This changes wording only. Your services, appointments, clients, team
          and connected calendars are never renamed or altered.
        </p>

        <FormError>{error}</FormError>

        <div>
          <button
            onClick={() => void save()}
            disabled={pending || !choice}
            className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? "Saving…" : selected ? "Save" : "That's my business"}
          </button>
        </div>
      </div>
    </Card>
  );
}

function isKnown(id: string): id is BusinessTypeId {
  return Object.prototype.hasOwnProperty.call(BUSINESS_TYPES, id);
}
