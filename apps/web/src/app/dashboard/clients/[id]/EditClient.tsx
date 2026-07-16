"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  archiveClientAction,
  editClientAction,
  unarchiveClientAction,
} from "../../actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

/**
 * Barber edit controls for a client's own profile: edit name/phone/email inline,
 * and soft-archive (hide, recoverable) or restore. Lives in the detail header so
 * the archive control has a single home (the list only badges archived rows).
 */
export function EditClient({
  clientId,
  firstName,
  lastName,
  phone,
  email,
  archived,
}: {
  clientId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  archived: boolean;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const [fFirst, setFFirst] = useState(firstName ?? "");
  const [fLast, setFLast] = useState(lastName ?? "");
  const [fPhone, setFPhone] = useState(phone ?? "");
  const [fEmail, setFEmail] = useState(email ?? "");

  function save() {
    const first = fFirst.trim();
    if (!first) {
      toast("First name can't be empty.", "error");
      return;
    }
    // Send only changed fields. "" is a deliberate clear for last/phone/email
    // (the server treats empty as null); undefined leaves a field untouched.
    const fields: {
      firstName?: string;
      lastName?: string | null;
      phone?: string | null;
      email?: string | null;
    } = {};
    if (first !== (firstName ?? "")) fields.firstName = first;
    if (fLast.trim() !== (lastName ?? "")) fields.lastName = fLast.trim();
    if (fPhone.trim() !== (phone ?? "")) fields.phone = fPhone.trim();
    if (fEmail.trim() !== (email ?? "")) fields.email = fEmail.trim();

    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const r = await editClientAction(clientId, fields);
      if (r.ok) {
        setEditing(false);
        toast("Client updated", "success");
      } else if (r.error === "invalid_phone") {
        toast("That phone number isn't valid. Use a US number like (302) 555-0142.", "error");
      } else {
        toast("Couldn't update client.", "error");
      }
    });
  }

  function archive() {
    startTransition(async () => {
      const r = await archiveClientAction(clientId);
      setConfirmArchive(false);
      if (r.ok) toast("Client archived", "success");
      else toast("Couldn't archive client.", "error");
    });
  }

  function restore() {
    startTransition(async () => {
      const r = await unarchiveClientAction(clientId);
      if (r.ok) toast("Client restored", "success");
      else toast("Couldn't restore client.", "error");
    });
  }

  if (editing) {
    return (
      <div className="flex w-full flex-col gap-2 rounded-2xl border border-subtle bg-charcoal-800 p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={fFirst}
            onChange={(e) => setFFirst(e.target.value)}
            placeholder="First name *"
            maxLength={80}
            className={field}
          />
          <input
            value={fLast}
            onChange={(e) => setFLast(e.target.value)}
            placeholder="Last name"
            maxLength={80}
            className={field}
          />
          <input
            value={fPhone}
            onChange={(e) => setFPhone(e.target.value)}
            type="tel"
            placeholder="Phone"
            maxLength={40}
            className={field}
          />
          <input
            value={fEmail}
            onChange={(e) => setFEmail(e.target.value)}
            type="email"
            placeholder="Email"
            maxLength={160}
            className={field}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={pending}
            className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={pending}
            className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => setEditing(true)}
        disabled={pending}
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
      >
        Edit profile
      </button>

      {archived ? (
        <button
          onClick={restore}
          disabled={pending}
          className="rounded-full border border-emerald-soft/40 px-4 py-2 text-xs text-emerald-soft transition-colors duration-150 ease-out hover:bg-emerald-soft/10 disabled:opacity-50"
        >
          {pending ? "…" : "Restore client"}
        </button>
      ) : confirmArchive ? (
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-muted">
            Hide this client from your active book? History is kept; you can restore them.
          </span>
          <button
            onClick={archive}
            disabled={pending}
            className="rounded-full bg-danger-soft/90 px-3 py-1.5 text-[11px] font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-danger-soft disabled:opacity-50"
          >
            {pending ? "…" : "Yes, archive"}
          </button>
          <button
            onClick={() => setConfirmArchive(false)}
            disabled={pending}
            className="text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          onClick={() => setConfirmArchive(true)}
          disabled={pending}
          className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:text-danger-soft hover:bg-charcoal-700 disabled:opacity-50"
        >
          Archive
        </button>
      )}
    </div>
  );
}
