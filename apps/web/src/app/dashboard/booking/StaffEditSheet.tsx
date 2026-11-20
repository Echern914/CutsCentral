"use client";

import { useRef, useState } from "react";
import { ImageField } from "../site/ImageField";
import { Sheet } from "./AppointmentForm";
import { updateStaffAction } from "./actions";

/**
 * One person's name and photo, from Calendar → Staff.
 *
 * Until this existed a person could be added and removed and nothing else: a
 * name typed wrong at setup stayed wrong, and someone whose account name was an
 * email address (so their place on the booking page was named "New ...") could
 * not be given their real name without being removed and re-added - which
 * throws away their hours.
 *
 * Both fields are what a client sees when choosing who to book. Saved together
 * on Save; what went wrong is said above the button, inside the sheet, because
 * a toast draws underneath it on a phone.
 */
export function StaffEditSheet({
  staff,
  onSaved,
  onClose,
}: {
  staff: { id: string; name: string; imageUrl: string | null };
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(staff.name);
  const [imageUrl, setImageUrl] = useState(staff.imageUrl ?? "");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);

  const dirty = name.trim() !== staff.name || imageUrl !== (staff.imageUrl ?? "");

  function attemptClose() {
    if (dirty && !window.confirm("You have unsaved changes. Close and lose them?")) return;
    onClose();
  }

  async function save() {
    if (busy.current) return;
    const clean = name.trim();
    if (!clean) {
      setProblem("Add a name. It is what clients see when they book.");
      return;
    }
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      setProblem("The photo link has to start with https://");
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    try {
      const r = await updateStaffAction(staff.id, { name: clean, imageUrl });
      if (r.ok) onSaved();
      else setProblem("Couldn't save. Your changes are still here, so try again.");
    } catch {
      setProblem("No answer from ChairBack. Your changes are still here, so try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <Sheet title={`Edit ${staff.name}`} onClose={attemptClose}>
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs text-muted">Name</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            maxLength={120}
            autoComplete="off"
            className="h-11 w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50"
          />
        </label>
        <ImageField
          label="Photo"
          kind="avatar"
          aspect="square"
          value={imageUrl}
          onChange={(url) => {
            setImageUrl(url);
            setProblem(null);
          }}
          hint="Optional. Clients see it next to the name when they choose who to book."
        />
        {problem && (
          <p role="alert" className="text-sm text-danger-soft">
            {problem}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </form>
    </Sheet>
  );
}
