"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import {
  createBookingQuestionAction,
  deleteBookingQuestionAction,
  seedBookingQuestionsAction,
  updateBookingQuestionAction,
  type BookingQuestionKind,
} from "./actions";
import type { BookingQuestionRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * WHAT THIS SHOP ASKS BEFORE IT CAN DO THE JOB.
 *
 * 🔴 THE TRADE THIS SCREEN IS ABOUT. A booking form is the narrowest part of
 * the funnel: every extra field loses people, and every REQUIRED field can
 * lose them at the last step. But a mobile mechanic with no address has
 * nowhere to drive, and no year/make/model has nothing to quote. So the screen
 * does two things and says both plainly - it offers the questions this kind of
 * business usually needs, and it makes "required" a deliberate switch with the
 * cost written next to it.
 *
 * Nothing is ever added on the owner's behalf. The suggestions are one tap,
 * idempotent, and every field is editable afterwards.
 */

const KINDS: { value: BookingQuestionKind; label: string; hint: string }[] = [
  { value: "text", label: "Short text", hint: "One line" },
  { value: "textarea", label: "Paragraph", hint: "A few lines" },
  { value: "address", label: "Address", hint: "Street address" },
  { value: "select", label: "Multiple choice", hint: "Pick one" },
  { value: "phone", label: "Phone", hint: "Number pad" },
  { value: "email", label: "Email", hint: "Checked for shape" },
  { value: "number", label: "Number", hint: "Digits" },
];

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

export function BookingQuestionsCard({
  initial,
  services,
  toast,
}: {
  initial: BookingQuestionRow[];
  /** Active services, so a question can be scoped to the ones that need it. */
  services: { id: string; name: string; active: boolean }[];
  toast: Toast;
}) {
  const vocab = useVocab();
  const [questions, setQuestions] = useState(initial);
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<BookingQuestionKind>("text");
  const [required, setRequired] = useState(false);
  const [helpText, setHelpText] = useState("");
  const [optionsText, setOptionsText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // [] = every service. The common case, and the default.
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const bookable = services.filter((s) => s.active);
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? "a service";

  /** "Every service", or the ones it is scoped to, named. */
  function scopeLabel(ids: string[]): string {
    if (ids.length === 0) return "Every service";
    if (ids.length <= 2) return ids.map(nameOf).join(" · ");
    return `${ids.length} services`;
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  const optionList = optionsText
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);

  function resetForm() {
    setLabel("");
    setKind("text");
    setRequired(false);
    setHelpText("");
    setOptionsText("");
    setServiceIds([]);
  }

  function add() {
    const trimmed = label.trim();
    if (!trimmed) return;
    if (kind === "select" && optionList.length === 0) {
      toast("A multiple-choice question needs at least one option.", "error");
      return;
    }
    start(async () => {
      const r = await createBookingQuestionAction({
        label: trimmed,
        kind,
        required,
        helpText: helpText.trim() || null,
        options: kind === "select" ? optionList : [],
        serviceIds,
        // New questions go to the end of the form the customer sees.
        sortOrder: questions.reduce((max, q) => Math.max(max, q.sortOrder), -1) + 1,
      });
      if (!r.ok) {
        toast("Couldn't add that question.", "error");
        return;
      }
      // The id comes back on the next server render; until then show it
      // locally so the list never looks like the tap did nothing.
      setQuestions((prev) => [
        ...prev,
        {
          id: `pending-${Date.now()}`,
          label: trimmed,
          helpText: helpText.trim() || null,
          kind,
          required,
          options: kind === "select" ? optionList : [],
          serviceIds,
          sortOrder: prev.length,
          active: true,
          templateKey: null,
        },
      ]);
      resetForm();
      toast("Question added.", "success");
    });
  }

  function patch(id: string, input: Parameters<typeof updateBookingQuestionAction>[1]) {
    const before = questions;
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...input } : q)));
    start(async () => {
      const r = await updateBookingQuestionAction(id, input);
      if (!r.ok) {
        setQuestions(before); // put it back rather than lie about the save
        toast("Couldn't save that change.", "error");
      }
    });
  }

  function remove(id: string, name: string) {
    if (!window.confirm(`Remove "${name}" from your booking form?`)) return;
    const before = questions;
    setQuestions((prev) => prev.filter((q) => q.id !== id));
    start(async () => {
      const r = await deleteBookingQuestionAction(id);
      if (!r.ok) {
        setQuestions(before);
        toast("Couldn't remove that question.", "error");
        return;
      }
      // Said plainly, because it is the first thing anyone worries about here.
      toast("Removed. Past bookings keep their answers.", "success");
    });
  }

  function seed() {
    start(async () => {
      const r = await seedBookingQuestionsAction();
      if (!r.ok) {
        toast("Couldn't add the suggested questions.", "error");
        return;
      }
      if ((r.added ?? 0) === 0) {
        toast("You already have all of them.", "success");
        return;
      }
      toast(`Added ${r.added} question${r.added === 1 ? "" : "s"}. Edit anything you like.`, "success");
      // The rows themselves arrive with the revalidated page.
      window.location.reload();
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="What you ask when someone books"
        subtitle={`Beyond a name and a way to reach them. Ask for what you can't start the ${vocab.serviceNoun} without.`}
      />

      <div className="mt-4 flex flex-col gap-2">
        {questions.length === 0 ? (
          <p className="text-sm text-muted">
            You ask nothing extra right now — customers give a name, a phone and
            an email. That&apos;s the right setup for most shops.
          </p>
        ) : (
          questions.map((q) => (
            <div
              key={q.id}
              className={cn(
                "rounded-xl border border-subtle px-3.5 py-3",
                !q.active && "opacity-60",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-offwhite [overflow-wrap:anywhere]">
                    {q.label}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {KINDS.find((k) => k.value === q.kind)?.label ?? q.kind}
                    {q.required ? " · Required" : " · Optional"}
                    {" · "}
                    {scopeLabel(q.serviceIds)}
                    {!q.active && " · Hidden"}
                  </p>
                  {q.helpText && (
                    <p className="mt-0.5 text-xs text-muted/80 [overflow-wrap:anywhere]">
                      {q.helpText}
                    </p>
                  )}
                  {q.kind === "select" && q.options.length > 0 && (
                    <p className="mt-0.5 text-xs text-muted/80">{q.options.join(" · ")}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingId(editingId === q.id ? null : q.id)}
                    className="text-xs font-medium text-muted transition-colors hover:text-offwhite"
                  >
                    {editingId === q.id ? "Done" : "Edit"}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(q.id, q.label)}
                    disabled={pending}
                    className="text-xs font-medium text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {editingId === q.id && (
                <div className="mt-3 flex flex-col gap-2 border-t border-subtle pt-3">
                  <input
                    className={field}
                    value={q.label}
                    aria-label="Question"
                    onChange={(e) =>
                      setQuestions((prev) =>
                        prev.map((x) => (x.id === q.id ? { ...x, label: e.target.value } : x)),
                      )
                    }
                    onBlur={(e) => patch(q.id, { label: e.target.value.trim() || q.label })}
                  />
                  <input
                    className={field}
                    value={q.helpText ?? ""}
                    placeholder="Help text (optional)"
                    aria-label="Help text"
                    onChange={(e) =>
                      setQuestions((prev) =>
                        prev.map((x) => (x.id === q.id ? { ...x, helpText: e.target.value } : x)),
                      )
                    }
                    onBlur={(e) => patch(q.id, { helpText: e.target.value.trim() || null })}
                  />
                  {bookable.length > 0 && (
                    <div>
                      <p className="text-xs text-muted">Ask this on</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <ScopeChip
                          label="Every service"
                          on={q.serviceIds.length === 0}
                          onClick={() => patch(q.id, { serviceIds: [] })}
                        />
                        {bookable.map((svc) => (
                          <ScopeChip
                            key={svc.id}
                            label={svc.name}
                            on={q.serviceIds.includes(svc.id)}
                            onClick={() => patch(q.id, { serviceIds: toggle(q.serviceIds, svc.id) })}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={q.required}
                        onChange={(e) => patch(q.id, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={q.active}
                        onChange={(e) => patch(q.id, { active: e.target.checked })}
                      />
                      Show on the booking page
                    </label>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* The suggestions. Never applied on their own - this is a button, and
          it is idempotent, so pressing it twice is safe. */}
      <button
        type="button"
        onClick={seed}
        disabled={pending}
        className="mt-4 self-start rounded-xl border border-subtle px-4 py-2 text-sm font-medium text-offwhite transition-colors hover:border-strong disabled:opacity-50"
      >
        {pending ? "Working…" : "Add the suggested questions for my business"}
      </button>

      <div className="mt-5 border-t border-subtle pt-4">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
          Add a question
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <input
            className={field}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Service address"
            aria-label="Question"
            maxLength={120}
          />
          <input
            className={field}
            value={helpText}
            onChange={(e) => setHelpText(e.target.value)}
            placeholder="Help text (optional) — e.g. Where should we meet the vehicle?"
            aria-label="Help text"
            maxLength={200}
          />
          <div className="flex flex-wrap items-center gap-3">
            <select
              className={cn(field, "w-auto")}
              value={kind}
              onChange={(e) => setKind(e.target.value as BookingQuestionKind)}
              aria-label="Answer type"
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required
            </label>
          </div>
          {kind === "select" && (
            <textarea
              className={cn(field, "min-h-[72px] resize-y")}
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder={"One option per line\nAutomatic\nManual"}
              aria-label="Options, one per line"
            />
          )}
          {bookable.length > 0 && (
            <div>
              <p className="text-xs text-muted">Ask this on</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <ScopeChip
                  label="Every service"
                  on={serviceIds.length === 0}
                  onClick={() => setServiceIds([])}
                />
                {bookable.map((svc) => (
                  <ScopeChip
                    key={svc.id}
                    label={svc.name}
                    on={serviceIds.includes(svc.id)}
                    onClick={() => setServiceIds((prev) => toggle(prev, svc.id))}
                  />
                ))}
              </div>
              {/* The reason this control exists, in the words of the trade that
                  needed it. */}
              <p className="mt-1.5 text-xs text-muted">
                Pick the ones that need it — a job you drive to needs an address;
                one done in your own {vocab.stationNoun} doesn&apos;t.
              </p>
            </div>
          )}
          {/* 🔴 The cost, said before they tick it - not after a week of lost
              bookings nobody can explain. */}
          {required && (
            <p className="text-xs text-gold">
              Customers won&apos;t be able to book without answering this. Worth it
              for something you genuinely can&apos;t start without.
            </p>
          )}
          <button
            type="button"
            onClick={add}
            disabled={pending || !label.trim()}
            className="self-start rounded-xl bg-gold px-4 py-2 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add question"}
          </button>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted">
        Answers show on the booking in your calendar. Removing a question never
        blanks what someone already answered.
      </p>
    </Card>
  );
}

/** One service in the "ask this on" picker. On = this question is asked there. */
function ScopeChip({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-colors",
        on ? "bg-gold/20 text-gold" : "border border-subtle text-muted hover:text-offwhite",
      )}
    >
      {label}
    </button>
  );
}
