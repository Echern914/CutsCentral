"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { PARTNER_PROGRAM } from "@chairback/config/partnerProgram";
import { formatTierMoney as money } from "@chairback/config/tierRules";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { LocalDate } from "@/components/ui/LocalDate";
import { useToast } from "@/components/ui/Toast";
import { createPartnerAction, markPartnerCashoutPaidAction, setPartnerActiveAction } from "./actions";

/** GET /api/admin-portal/partners - see services/partnerProgram.ts partnersForAdmin. */
export interface AdminPartners {
  partners: {
    id: string;
    name: string;
    code: string;
    email: string | null;
    active: boolean;
    createdAt: string;
    standing: {
      signups: number;
      qualified: number;
      unlock: { unlocked: boolean; window: { closesAt: string; count: number; open: boolean } | null };
      earnedCents: number;
      lockedCents: number;
      availableCents: number;
      requestedCents: number;
      paidOutCents: number;
    };
  }[];
  pendingCashouts: { id: string; partnerId: string; partnerName: string; amountCents: number; requestedAt: string }[];
}

const CREATE_ERRORS: Record<string, string> = {
  invalid_code: "Codes are letters and numbers (spaces are fine).",
  code_taken: "Another partner already has that code (case and spaces don't count).",
  no_such_user: `No ${APP_NAME} login has that email. Leave it blank for a partner without one.`,
  user_taken: "That login is already a partner.",
  invalid_input: "Give the partner a name and a code.",
};

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/**
 * PARTNERS: people ChairBack pays in cash for bringing businesses in.
 *
 * Nothing on this card moves money. A partner asks for a cashout from their own
 * page; the admin pays it outside ChairBack, then presses "Mark paid" here -
 * which only records that it was paid. Every number is recomputed by the API
 * from the rows, and the page re-reads after each action rather than guessing.
 */
export function PartnersSection({ data }: { data: AdminPartners }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    if (busy) return;
    setBusy(key);
    try {
      const r = await fn();
      if (r.ok) {
        toast(done, "success");
        router.refresh();
      } else {
        toast("That didn't go through. Nothing changed.", "error");
      }
    } finally {
      setBusy(null);
    }
  }

  async function create(form: HTMLFormElement) {
    if (busy) return;
    const f = new FormData(form);
    setBusy("create");
    setCreateError(null);
    try {
      const r = await createPartnerAction(
        String(f.get("name") ?? ""),
        String(f.get("code") ?? ""),
        String(f.get("email") ?? ""),
      );
      if (r.ok) {
        form.reset();
        toast("Partner added", "success");
        router.refresh();
      } else {
        setCreateError(CREATE_ERRORS[r.error ?? ""] ?? "Couldn't add that partner.");
      }
    } finally {
      setBusy(null);
    }
  }

  const field =
    "rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted";

  return (
    <>
      <h2 className="mb-1 mt-10 font-display text-lg">Partners</h2>
      <p className="mb-3 text-sm text-muted">
        {money(PARTNER_PROGRAM.rewardCents)} once per business that signs up with a partner&apos;s code
        and pays for a plan. Cashout unlocks at {PARTNER_PROGRAM.unlock.referrals} within{" "}
        {PARTNER_PROGRAM.unlock.windowDays} days. Pay by hand, then mark paid.
      </p>

      {data.pendingCashouts.length > 0 ? (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-muted">Cashouts to pay</p>
          <ul className="divide-y divide-subtle/60 text-sm">
            {data.pendingCashouts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-medium text-offwhite">{c.partnerName}</span> ·{" "}
                  {money(c.amountCents)} · asked <LocalDate iso={c.requestedAt} options={SHORT_DATE} />
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(c.id, () => markPartnerCashoutPaidAction(c.id), `Marked ${money(c.amountCents)} paid`)
                  }
                  className="rounded-full border border-subtle px-3 py-1 text-xs hover:bg-charcoal-700 disabled:opacity-50"
                >
                  {busy === c.id ? "Saving…" : "Mark paid"}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-subtle text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Partner</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Signed up / paying</th>
                <th className="px-4 py-3 font-medium">Cashout</th>
                <th className="px-4 py-3 font-medium">Earned / available</th>
                <th className="px-4 py-3 font-medium">Paid out</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.partners.map((p) => (
                <tr key={p.id} className="border-b border-subtle/60 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-offwhite">{p.name}</p>
                    <p className="text-xs text-muted">{p.email ?? "No login"}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{p.code}</td>
                  <td className="px-4 py-3 text-muted">
                    {p.standing.signups} / {p.standing.qualified}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {p.standing.unlock.unlocked ? (
                      <span className="text-emerald-soft">Unlocked</span>
                    ) : p.standing.unlock.window ? (
                      <span className="text-muted">
                        Locked · {p.standing.unlock.window.count} of {PARTNER_PROGRAM.unlock.referrals}
                        {p.standing.unlock.window.open ? (
                          <>
                            , closes <LocalDate iso={p.standing.unlock.window.closesAt} options={SHORT_DATE} />
                          </>
                        ) : (
                          ", window lapsed"
                        )}
                      </span>
                    ) : (
                      <span className="text-muted">Locked</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {money(p.standing.earnedCents)} / {money(p.standing.availableCents)}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {money(p.standing.paidOutCents)}
                    {p.standing.requestedCents > 0 ? (
                      <span className="text-xs"> (+{money(p.standing.requestedCents)} asked)</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(
                          `active:${p.id}`,
                          () => setPartnerActiveAction(p.id, !p.active),
                          p.active ? `${p.name}'s code is paused` : `${p.name}'s code is back on`,
                        )
                      }
                      className="rounded-full border border-subtle px-3 py-1 text-xs hover:bg-charcoal-700 disabled:opacity-50"
                    >
                      {p.active ? "Pause" : "Resume"}
                    </button>
                  </td>
                </tr>
              ))}
              {data.partners.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted">
                    No partners yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <form
        className="mt-3 flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create(e.currentTarget);
        }}
      >
        <input name="name" required maxLength={80} placeholder="Name" aria-label="Partner name" className={field} />
        <input name="code" required maxLength={64} placeholder='Code, e.g. "ERIC C"' aria-label="Partner code" className={field} />
        <input
          name="email"
          type="email"
          maxLength={254}
          placeholder={`Their ${APP_NAME} login email (optional)`}
          aria-label="Partner login email (optional)"
          className={`${field} min-w-[16rem]`}
        />
        <button
          type="submit"
          disabled={busy !== null}
          className="rounded-full bg-gold-gradient px-4 py-2 text-sm font-semibold text-charcoal disabled:opacity-50"
        >
          {busy === "create" ? "Adding…" : "Add partner"}
        </button>
      </form>
      <FormError className="mt-2">{createError}</FormError>
    </>
  );
}
