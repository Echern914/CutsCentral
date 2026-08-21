"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  createUpgradeRuleAction,
  deleteUpgradeRuleAction,
  listUpgradeRulesAction,
  updateUpgradeRuleAction,
  type UpgradeRuleRow,
} from "./actions";
import type { ServiceRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "Book a Cut, get offered the VIP."
 *
 * The booking page has always suggested upgrades - it worked them out itself as
 * "longer AND dearer, offered by this barber". That is a reasonable guess and
 * it is not the barber's judgement: it will cheerfully push a beard trim at
 * someone booking a kids' cut. This is where they say which upsell belongs on
 * which service.
 *
 * 🔑 A RULE ONLY PICKS CANDIDATES. Whether the prompt actually appears is still
 * decided by real availability at the customer's chosen time - the length has
 * to fit before the next appointment, inside the barber's hours, past blocked
 * time and the day's limit. Saying so on the card matters, because a barber who
 * thinks this GUARANTEES the prompt will report it as broken the first time a
 * busy afternoon hides it.
 *
 * No rules at all = the automatic suggestions carry on exactly as before, so
 * nobody loses their upsells by not visiting this card.
 */
export function UpgradeRules({
  services,
  toast,
}: {
  services: ServiceRow[];
  toast: Toast;
}) {
  const [rules, setRules] = useState<UpgradeRuleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [destId, setDestId] = useState("");

  const active = services.filter((s) => s.active);
  const nameOf = (id: string) => active.find((s) => s.id === id)?.name ?? "(removed)";

  function refresh() {
    start(() => {
      void listUpgradeRulesAction().then((res) => {
        if (res.ok) setRules(res.rules ?? []);
        setLoaded(true);
      });
    });
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setAdding(false);
    setSourceIds([]);
    setDestId("");
  }

  function save() {
    if (sourceIds.length === 0) {
      toast("Pick at least one service to upgrade from", "error");
      return;
    }
    if (!destId) {
      toast("Pick what to offer them", "error");
      return;
    }
    start(() => {
      void createUpgradeRuleAction({
        sourceServiceIds: sourceIds,
        destinationServiceId: destId,
      }).then((r) => {
      if (r.ok) {
        toast("Upgrade prompt added", "success");
        reset();
        refresh();
      } else {
        // self_upgrade / cycle come back as actionable codes, not noise.
        toast(
          r.error === "self_upgrade"
            ? "A service can't be an upgrade of itself"
            : r.error === "cycle"
              ? "Those two would be upgrades of each other — pick a different one"
              : "Couldn't add that",
          "error",
        );
      }
      });
    });
  }

  function toggle(rule: UpgradeRuleRow) {
    start(() => {
      void updateUpgradeRuleAction(rule.id, { active: !rule.active }).then((r) => {
        if (r.ok) refresh();
        else toast("Couldn't update", "error");
      });
    });
  }

  function remove(rule: UpgradeRuleRow) {
    start(() => {
      void deleteUpgradeRuleAction(rule.id).then((r) => {
        if (r.ok) {
          toast("Removed", "success");
          refresh();
        } else toast("Couldn't remove", "error");
      });
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="Upgrade prompts"
        subtitle="Offer a bigger service to someone who just picked a smaller one."
      />
      <p className="mt-2 text-[11px] text-muted">
        Only shown when it actually{" "}
        <span className="text-offwhite">fits their time</span> — the longer
        service has to finish before the next appointment, inside your hours.
        Set none and we&rsquo;ll keep suggesting longer, pricier services on our
        own.
      </p>

      {loaded && rules.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Nothing set up. We&rsquo;re suggesting upgrades automatically.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-subtle overflow-hidden rounded-xl border border-subtle">
          {rules.map((r) => (
            <li
              key={r.id}
              className={cn(
                "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5",
                !r.active && "opacity-50",
              )}
            >
              <p className="min-w-0 text-sm text-offwhite">
                {r.sourceServiceIds.map(nameOf).join(", ")}{" "}
                <span aria-hidden="true" className="text-muted">
                  →
                </span>{" "}
                <span className="sr-only">upgrades to</span>
                <span className="font-semibold text-gold">
                  {nameOf(r.destinationServiceId)}
                </span>
              </p>
              <span className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggle(r)}
                  disabled={pending}
                  aria-pressed={r.active}
                  className="text-xs text-muted hover:text-gold hover:underline disabled:opacity-50"
                >
                  {r.active ? "Turn off" : "Turn on"}
                </button>
                <button
                  type="button"
                  onClick={() => remove(r)}
                  disabled={pending}
                  className="text-xs text-danger-soft hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={active.length < 2}
          className="mt-4 rounded-lg bg-gold/15 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
        >
          + Add an upgrade prompt
        </button>
      ) : (
        <div className="mt-4 rounded-xl border border-gold/40 bg-gold/5 p-3">
          <span className="block text-xs text-muted">When someone books</span>
          <div
            role="group"
            aria-label="Services this prompt applies to"
            className="mt-1.5 flex flex-wrap gap-1.5"
          >
            {active.map((s) => {
              const on = sourceIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setSourceIds((cur) =>
                      cur.includes(s.id)
                        ? cur.filter((x) => x !== s.id)
                        : [...cur, s.id],
                    )
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    on
                      ? "border-gold/60 bg-gold/15 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {s.name}
                </button>
              );
            })}
          </div>

          <label className="mt-3 block">
            <span className="block text-xs text-muted">Offer them</span>
            <select
              value={destId}
              onChange={(e) => setDestId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite outline-none focus:border-gold/50 sm:max-w-xs"
            >
              <option value="">Choose a service…</option>
              {active
                // A service cannot be an upgrade of itself, so the one(s) they
                // picked as sources are not offered here. The API enforces it
                // too - this just avoids a pointless error.
                .filter((s) => !sourceIds.includes(s.id))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-lg bg-gold/20 px-3 py-1.5 text-xs font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Add prompt"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded px-2 py-1.5 text-xs text-muted transition-colors hover:text-offwhite"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
