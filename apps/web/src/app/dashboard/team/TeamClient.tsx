"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { ShopRole, TeamData } from "./page";
import {
  inviteMemberAction,
  removeMemberAction,
  revokeInviteAction,
  teamAction,
  updateMemberAction,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

const ROLE_LABEL: Record<ShopRole, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  BARBER: "Barber",
};

const ROLE_HINT: Record<ShopRole, string> = {
  OWNER: "Full access, including billing and the team.",
  MANAGER: "Runs the shop day to day. No billing or team changes.",
  BARBER: "Their own chair. Sign-in works; their dashboard is coming next.",
};

/** Turn an API error code into something a shop owner can act on. */
function explain(code: string | undefined): string {
  switch (code) {
    case "already_member":
      return "They're already on your team.";
    case "staff_taken":
      return "That chair is already linked to someone else.";
    case "invalid_staff":
      return "Pick a chair from your booking staff.";
    case "email_unavailable":
      return "Email isn't set up yet, so invites can't be sent.";
    case "email_failed":
      return "We couldn't send the email. Check the address and try again.";
    case "cannot_modify_owner":
    case "cannot_remove_owner":
      return "The owner's access can't be changed here.";
    case "forbidden_role":
      return "Only the owner can change the team.";
    default:
      return "That didn't work. Try again.";
  }
}

/**
 * The shop's people: who can sign in, what they can do, and which chair they
 * work. Owners invite, change roles, and revoke; managers can see the roster
 * but not change it (the API enforces this — we just don't render the
 * controls, so nobody is offered a button that will 403).
 */
export function TeamClient({ initial }: { initial: TeamData }) {
  const { toast } = useToast();
  const [data, setData] = useState<TeamData>(initial);
  const [pending, start] = useTransition();
  const isOwner = data.role === "OWNER";

  // Invite form
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MANAGER" | "BARBER">("BARBER");
  const [staffId, setStaffId] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** Run a mutation, then re-read the roster so the UI can't drift. */
  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(explain(res.error));
        toast(explain(res.error), "error");
        return;
      }
      setError(null);
      const fresh = await teamAction();
      if (fresh) setData(fresh);
      toast(okMsg, "success");
    });
  }

  function submitInvite() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Add an email address.");
      return;
    }
    run(
      () =>
        inviteMemberAction({
          email: trimmed,
          role,
          ...(staffId ? { staffId } : {}),
        }),
      "Invitation sent",
    ).valueOf();
    setEmail("");
    setStaffId("");
  }

  // Chairs not yet claimed by a seat — the only ones worth offering.
  const linkedStaffIds = new Set(
    [
      ...data.members.map((m) => m.staffId),
      ...data.invites.map((i) => i.staffId),
    ].filter(Boolean) as string[],
  );
  const freeStaff = data.staff.filter((s) => !linkedStaffIds.has(s.id));
  const staffName = (id: string | null) =>
    id ? (data.staff.find((s) => s.id === id)?.name ?? "—") : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl">Team</h1>
        <p className="mt-1 text-sm text-muted">
          Everyone who can sign in to your shop. Adding someone here does not
          change your booking staff — a chair and a login are separate things.
        </p>
      </div>

      {/* Invite */}
      {isOwner && (
        <Card className="overflow-hidden">
          <CardHeader
            title="Invite someone"
            subtitle="They get an email link. It works once, expires in 7 days, and only for that address."
          />
          <div className="flex flex-col gap-3 px-5 py-5">
            {!data.inviteAvailable ? (
              <p className="text-sm text-muted">
                Invitations need email to be configured. Once it is, you can
                invite your barbers from here.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    className={field}
                    type="email"
                    autoComplete="off"
                    placeholder="barber@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-label="Email address"
                  />
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as "MANAGER" | "BARBER")}
                    aria-label="Role"
                    className="rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite"
                  >
                    <option value="BARBER">Barber</option>
                    <option value="MANAGER">Manager</option>
                  </select>
                  {freeStaff.length > 0 && (
                    <select
                      value={staffId}
                      onChange={(e) => setStaffId(e.target.value)}
                      aria-label="Link to a chair"
                      className="rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite"
                    >
                      <option value="">No chair</option>
                      {freeStaff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={submitInvite}
                    disabled={pending}
                    className="shrink-0 rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
                  >
                    {pending ? "Sending…" : "Send invite"}
                  </button>
                </div>
                <p className="text-[11px] text-muted/80">{ROLE_HINT[role]}</p>
                <FormError>{error}</FormError>
              </>
            )}
          </div>
        </Card>
      )}

      {/* Pending invites */}
      {data.invites.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Pending invitations" subtitle="Sent, not accepted yet." />
          <ul className="divide-y divide-subtle">
            {data.invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-offwhite">{i.email}</p>
                  <p className="text-xs text-muted">
                    {ROLE_LABEL[i.role]}
                    {i.staffId && ` · ${staffName(i.staffId)}`} · expires{" "}
                    {new Date(i.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                {isOwner && (
                  <button
                    onClick={() =>
                      run(() => revokeInviteAction(i.id), "Invitation revoked")
                    }
                    disabled={pending}
                    className="shrink-0 text-xs text-rose-300 transition-colors hover:text-rose-200 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Members */}
      <Card className="overflow-hidden">
        <CardHeader title="People" subtitle="Everyone with access to this shop." />
        <ul className="divide-y divide-subtle">
          {data.members.map((m) => {
            const isTheOwner = m.user.id === data.ownerUserId;
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-offwhite">
                    <span className="truncate font-medium">{m.user.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                        isTheOwner
                          ? "bg-gold/15 text-gold"
                          : "bg-charcoal-600/60 text-muted",
                      )}
                    >
                      {ROLE_LABEL[m.role]}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted">
                    {m.user.email}
                    {m.staffId && ` · ${staffName(m.staffId)}`}
                  </p>
                </div>

                {isOwner && !isTheOwner && (
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={m.role}
                      onChange={(e) =>
                        run(
                          () =>
                            updateMemberAction(m.id, {
                              role: e.target.value as "MANAGER" | "BARBER",
                            }),
                          "Role updated",
                        )
                      }
                      disabled={pending}
                      aria-label={`Role for ${m.user.name}`}
                      className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite"
                    >
                      <option value="BARBER">Barber</option>
                      <option value="MANAGER">Manager</option>
                    </select>
                    <button
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove ${m.user.name}'s access? Their chair, hours and appointment history stay exactly as they are.`,
                          )
                        ) {
                          return;
                        }
                        run(() => removeMemberAction(m.id), "Access removed");
                      }}
                      disabled={pending}
                      className="text-xs text-rose-300 transition-colors hover:text-rose-200 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <p className="text-[11px] text-muted/80">
        Removing someone takes away their sign-in only. To stop a barber
        appearing on your booking page, deactivate their chair under Booking →
        Staff.
      </p>
    </div>
  );
}
