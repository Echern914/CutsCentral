"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVocab } from "@/components/VocabProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormFooter, Group, INPUT, chip } from "../booking/formkit";
import { getBarberClientsAction, type BarberClientRow } from "./barberClientActions";
import {
  bookOwnAction,
  getOwnServicesAction,
  getOwnSlotsAction,
  type OwnService,
  type OwnSlot,
} from "./barberCalendarActions";
import { longDay, newSubmissionId, timeIn } from "./ownCalendarTime";

/** What a refused booking says, in words the person can act on. */
function bookProblem(code: string | undefined): string {
  switch (code) {
    case "slot_taken":
    case "invalid_slot":
    case "slot_unavailable_external":
    case "external_block":
      return "That time was just taken. Pick another one.";
    case "client_not_found":
      return "Couldn't find that person on your list. Search again, or add them as someone new.";
    case "invalid_phone":
      return "That phone number doesn't look right. Fix it, or leave it out.";
    case "not_native":
      return "Booking from here isn't turned on for this shop.";
    case "operation_mismatch":
    case "operation_in_progress":
    case "replay_not_booked":
      return "An earlier try may have gone through. Close this and check your day before booking again.";
    case "network_error":
      return "Couldn't reach the server. Tap Book again: it will not book twice.";
    case "invalid_input":
      return "Something in the form isn't right. Check the name and the time.";
    default:
      return "Couldn't book it. Nothing was booked. Try again.";
  }
}

/**
 * Book a client on their own calendar: who, which service, which day, which
 * open time. The times offered are the same ones the booking checks, so a
 * picked time is only refused when somebody else took it a moment earlier.
 *
 * The outcome (booked, or why not) is read in the dialog's footer.
 */
export function BarberBookSheet({
  timezone,
  startDay,
  today,
  onClose,
  onBooked,
}: {
  timezone: string;
  /** The day the form opens on ("YYYY-MM-DD", never before today). */
  startDay: string;
  today: string;
  onClose: () => void;
  /** Called with the day the new booking is on. */
  onBooked: (day: string) => void;
}) {
  const vocab = useVocab();
  const [who, setWho] = useState<"mine" | "new">("mine");
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<BarberClientRow[] | null>(null);
  const [client, setClient] = useState<BarberClientRow | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const [services, setServices] = useState<OwnService[] | null>(null);
  const [servicesFailed, setServicesFailed] = useState(false);
  const [serviceId, setServiceId] = useState<string | null>(null);

  const [date, setDate] = useState(startDay);
  const [slots, setSlots] = useState<OwnSlot[] | null>(null);
  const [slotsFailed, setSlotsFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // One id per submission. It survives a try that got no answer (so the next
  // tap is answered by whatever that try made) and is replaced once the server
  // has answered, either way.
  const submission = useRef(newSubmissionId());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askedSlots = useRef(0);

  // Their own people, to pick from. A new person's list is empty, and the form
  // opens on "Someone new" for them.
  const search = useCallback(async (q: string, first = false) => {
    const res = await getBarberClientsAction(q || undefined);
    if (!res.ok || !res.data) {
      if (first) setClients([]);
      return;
    }
    setClients(res.data.clients);
    if (first && res.data.clients.length === 0) setWho("new");
  }, []);

  const loadServices = useCallback(async () => {
    setServicesFailed(false);
    const res = await getOwnServicesAction();
    if (!res.ok || !res.data) {
      setServicesFailed(true);
      return;
    }
    setServices(res.data.services);
    if (res.data.services.length === 1) setServiceId(res.data.services[0]!.id);
  }, []);

  useEffect(() => {
    void search("", true);
    void loadServices();
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, loadServices]);

  const loadSlots = useCallback(async (d: string, service: string) => {
    const mine = ++askedSlots.current;
    setSlots(null);
    setSlotsFailed(false);
    setPicked(null);
    const res = await getOwnSlotsAction({ date: d, serviceId: service });
    if (mine !== askedSlots.current) return;
    if (res.ok && res.data) setSlots(res.data.slots);
    else setSlotsFailed(true);
  }, []);

  useEffect(() => {
    if (serviceId && !done) void loadSlots(date, serviceId);
  }, [serviceId, date, done, loadSlots]);

  function onQuery(q: string) {
    setQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void search(q), 300);
  }

  const hasWho = who === "mine" ? client !== null : firstName.trim().length > 0;
  const ready = hasWho && serviceId !== null && picked !== null;
  const whoName = who === "mine" ? (client?.name ?? "") : firstName.trim();

  async function book() {
    if (!ready || pending || !serviceId || !picked) return;
    setPending(true);
    setProblem(null);
    const res = await bookOwnAction({
      serviceId,
      startsAt: picked,
      ...(who === "mine"
        ? { clientId: client!.id }
        : {
            firstName: firstName.trim(),
            ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
            ...(email.trim() ? { email: email.trim() } : {}),
          }),
      operationId: submission.current,
    });
    setPending(false);
    if (res.ok) {
      setDone(`${whoName} is booked for ${longDay(date)} at ${timeIn(timezone, picked)}.`);
      onBooked(date);
      return;
    }
    // The server answered with a refusal: that submission is settled, and
    // whatever is tried next is a new one. No answer at all keeps the id.
    if (res.error !== "network_error") submission.current = newSubmissionId();
    setProblem(bookProblem(res.error));
    if (res.error === "slot_taken" || res.error === "invalid_slot") void loadSlots(date, serviceId);
  }

  const footer = done ? (
    <div className="flex w-full flex-col gap-2">
      <p role="status" className="text-sm text-offwhite">
        {done}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="flex h-11 w-full items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary"
      >
        Done
      </button>
    </div>
  ) : (
    <FormFooter
      error={problem}
      label={picked ? `Book ${timeIn(timezone, picked)}` : "Book"}
      pendingLabel="Booking…"
      pending={pending}
      disabled={!ready}
      onSubmit={() => void book()}
    />
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Book a ${vocab.clientNoun}`}
      subtitle="On your own calendar, at one of your open times."
      footer={footer}
      className="sm:max-w-md"
    >
      {!done && (
        <div className="flex min-w-0 flex-col gap-4">
          <Group title="Who">
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Who is it for">
              <button
                type="button"
                aria-pressed={who === "mine"}
                className={chip(who === "mine")}
                onClick={() => setWho("mine")}
              >
                One of mine
              </button>
              <button
                type="button"
                aria-pressed={who === "new"}
                className={chip(who === "new")}
                onClick={() => setWho("new")}
              >
                Someone new
              </button>
            </div>

            {who === "mine" ? (
              client ? (
                <div className="flex min-w-0 items-center gap-3 rounded-xl border border-subtle px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-offwhite">{client.name}</p>
                    {client.maskedPhone && (
                      <p className="truncate text-xs text-muted">{client.maskedPhone}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="flex min-h-[44px] shrink-0 items-center px-2 text-sm text-gold hover:underline"
                    onClick={() => setClient(null)}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <Field label="Search your list">
                    <input
                      type="search"
                      className={INPUT}
                      value={query}
                      placeholder="Name"
                      onChange={(e) => onQuery(e.target.value)}
                    />
                  </Field>
                  {clients === null ? (
                    <p className="text-sm text-muted">Loading your list…</p>
                  ) : clients.length === 0 ? (
                    <p className="text-sm text-muted">
                      {query
                        ? "Nobody on your list by that name. Add them as someone new."
                        : "Nobody on your list yet. Add them as someone new."}
                    </p>
                  ) : (
                    <ul className="flex max-h-56 min-w-0 flex-col gap-1.5 overflow-y-auto">
                      {clients.slice(0, 20).map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="flex min-h-[44px] w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-subtle px-3 text-left transition-colors duration-150 ease-out hover:border-subtle-strong"
                            onClick={() => setClient(c)}
                          >
                            <span className="min-w-0 truncate text-sm text-offwhite">{c.name}</span>
                            {c.maskedPhone && (
                              <span className="shrink-0 text-xs text-muted">{c.maskedPhone}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name">
                    <input
                      className={INPUT}
                      value={firstName}
                      maxLength={80}
                      autoComplete="off"
                      onChange={(e) => setFirstName(e.target.value)}
                    />
                  </Field>
                  <Field label="Last name">
                    <input
                      className={INPUT}
                      value={lastName}
                      maxLength={80}
                      autoComplete="off"
                      onChange={(e) => setLastName(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Mobile (optional)">
                  <input
                    type="tel"
                    inputMode="tel"
                    className={INPUT}
                    value={phone}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </Field>
                <Field label="Email (optional)" hint="Their confirmation goes here when you add one.">
                  <input
                    type="email"
                    inputMode="email"
                    className={INPUT}
                    value={email}
                    maxLength={200}
                    autoComplete="off"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
              </>
            )}
          </Group>

          <Group title={vocab.serviceNoun}>
            {servicesFailed ? (
              <div role="alert" className="flex flex-col items-start gap-2">
                <p className="text-sm text-danger-soft">Couldn&rsquo;t load what you offer.</p>
                <button
                  type="button"
                  className="flex min-h-[44px] items-center rounded-xl border border-subtle px-4 text-sm text-offwhite"
                  onClick={() => void loadServices()}
                >
                  Try again
                </button>
              </div>
            ) : services === null ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : services.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing is set up for you to offer yet. Ask the shop owner to add you to the menu.
              </p>
            ) : (
              <div className="flex min-w-0 flex-col gap-2" role="group" aria-label="What is it for">
                {services.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={serviceId === s.id}
                    className={chip(serviceId === s.id, "justify-between gap-3")}
                    onClick={() => setServiceId(s.id)}
                  >
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className="shrink-0 text-xs">
                      {s.durationMin} min{s.price !== null ? ` · $${s.price}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Group>

          <Group title="When">
            <Field label="Day">
              <input
                type="date"
                className={INPUT}
                value={date}
                min={today}
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
            </Field>
            {!serviceId ? (
              <p className="text-sm text-muted">Pick what it is for to see your open times.</p>
            ) : slotsFailed ? (
              <div role="alert" className="flex flex-col items-start gap-2">
                <p className="text-sm text-danger-soft">Couldn&rsquo;t load your open times.</p>
                <button
                  type="button"
                  className="flex min-h-[44px] items-center rounded-xl border border-subtle px-4 text-sm text-offwhite"
                  onClick={() => void loadSlots(date, serviceId)}
                >
                  Try again
                </button>
              </div>
            ) : slots === null ? (
              <p className="text-sm text-muted">Loading open times…</p>
            ) : slots.length === 0 ? (
              <p className="text-sm text-muted">No open times on {longDay(date)}. Try another day.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Open times">
                {slots.map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    aria-pressed={picked === s.startsAt}
                    className={chip(picked === s.startsAt)}
                    onClick={() => {
                      setPicked(s.startsAt);
                      setProblem(null);
                    }}
                  >
                    {timeIn(timezone, s.startsAt)}
                  </button>
                ))}
              </div>
            )}
          </Group>
        </div>
      )}
    </Dialog>
  );
}
