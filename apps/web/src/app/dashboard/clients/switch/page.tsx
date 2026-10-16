import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { resolveHref } from "@chairback/config/features";
import { apiGet } from "@/lib/api";
import { capitalize, getVocabulary } from "@/lib/vocab";
import { Card } from "@/components/ui/Card";
import { ReviewAsk } from "./ReviewAsk";

export const metadata: Metadata = { title: "Switching from Booksy or TheCut" };

/** The shop facts this guide reads from /api/shops/me. */
interface ShopForGuide {
  name: string;
  slug: string | null;
  publicPageEnabled: boolean;
  /** Omitted sections are hidden; an empty list means the default order (reviews shown). */
  sectionOrder: string[];
}

const primaryBtn =
  "inline-flex items-center justify-center rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted";
const quietBtn =
  "inline-flex items-center justify-center rounded-full border border-subtle px-4 py-2 text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700";

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted marker:text-gold">
      {items.map((item, i) => (
        <li key={i} className="min-w-0 break-words pl-1">
          {item}
        </li>
      ))}
    </ol>
  );
}

const em = (text: string) => <span className="text-offwhite">{text}</span>;

/**
 * SWITCHING FROM BOOKSY OR THECUT - a booth-rent shop owner's ask: bring the
 * clients, the hours and the reviews across. Three short sections, each with
 * the exact steps on the old app and one button here.
 *
 * What can and can't move, as of 2026-10:
 *  - Clients: Booksy Biz exports them (Customers -> Export to CSV). TheCut has
 *    NO export; its barbers keep clients in their phone's contacts, so a
 *    contacts file (.vcf) is the way out - reviewed row by row in the
 *    importer, because it also holds friends and family.
 *  - Hours: copied from the old profile and pasted into the hours editor.
 *  - Reviews: neither app exports them, and ChairBack will not type them in by
 *    hand - nobody could check them. The barber asks regulars again, from
 *    their own phone, with their review link. ChairBack sends nothing.
 *  - Appointments: not imported. Booksy support can email the history on
 *    request; upcoming bookings are re-made by the client on the new link.
 */
export default async function SwitchGuidePage() {
  const [shopRes, vocab] = await Promise.all([apiGet<ShopForGuide>("/api/shops/me"), getVocabulary()]);
  const shop = shopRes.data;
  const appBase = process.env.APP_BASE_URL ?? "";
  const pageLive = Boolean(shop?.slug && shop.publicPageEnabled);
  const reviewsShown = !shop?.sectionOrder?.length || shop.sectionOrder.includes("reviews");
  const servicesHref = resolveHref("services") ?? "/dashboard/booking?tab=Services";
  const hoursHref = resolveHref("staff") ?? "/dashboard/booking?tab=Staff";
  const pageHref = resolveHref("mini-site") ?? "/dashboard/site";
  const Clients = capitalize(vocab.clientNounPlural);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-5">
      <header className="mb-6">
        <Link
          href="/dashboard/clients"
          className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
        >
          ← {Clients}
        </Link>
        <h1 className="mt-1 font-display text-3xl tracking-tight">Switching from Booksy or TheCut</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Bring your {vocab.clientNounPlural}, your services and your hours with you,
          and start collecting reviews on your own page. Four steps, about twenty minutes.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <Card className="min-w-0 p-5">
          <h2 className="font-display text-lg">1. Your {vocab.clientNounPlural}</h2>

          <h3 className="mt-3 text-sm font-semibold text-offwhite">From Booksy</h3>
          <Steps
            items={[
              <>In Booksy Biz, open {em("Customers")} and choose {em("Export to CSV")}.</>,
              <>Import that file here. If you get an Excel file instead, open it and save it as CSV first.</>,
            ]}
          />

          <h3 className="mt-4 text-sm font-semibold text-offwhite">From TheCut</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            TheCut has no export. Your {vocab.clientNounPlural} are in your
            phone&apos;s contacts, so export those as a contacts file (.vcf) and
            import that.
          </p>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted">iPhone</p>
          <Steps
            items={[
              <>Open {em("Contacts")} and tap {em("Lists")} at the top left.</>,
              <>
                Press and hold {em("All Contacts")} (or a list you keep for{" "}
                {vocab.clientNounPlural}), then tap {em("Export")}.
              </>,
              <>Save the .vcf file to Files, then import it here.</>,
            ]}
          />
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Android</p>
          <Steps
            items={[
              <>Open the {em("Contacts")} app and go to {em("Fix & manage")} (on some phones, {em("Settings")}).</>,
              <>Tap {em("Export to file")} and save the .vcf file.</>,
              <>Import it here.</>,
            ]}
          />
          <p className="mt-3 rounded-xl border border-subtle bg-charcoal-700/50 p-3 text-xs leading-relaxed text-muted">
            Your phone&apos;s contacts include friends and family. Before anything
            is added you&apos;ll see everyone in the file and can untick anyone who
            isn&apos;t a {vocab.clientNoun}. Nobody imported is texted until they
            opt in themselves.
          </p>
          <div className="mt-4">
            <Link href="/dashboard/clients?import=1" className={primaryBtn}>
              Import your {vocab.clientNounPlural}
            </Link>
          </div>
        </Card>

        <Card className="min-w-0 p-5">
          <h2 className="font-display text-lg">2. Your services</h2>
          <Steps
            items={[
              <>Open your profile on Booksy, TheCut or Google and copy your service menu: the names, prices and lengths.</>,
              <>
                Here, open {em("Calendar → Services")} and tap {em("Paste your menu from another app")}.
              </>,
              <>
                Paste it and tap {em("Read my menu")}. Check each service, add any length it couldn&apos;t
                find, untick anything you don&apos;t offer any more, then tap {em("Add")}.
              </>,
            ]}
          />
          <div className="mt-4">
            <Link href={servicesHref} className={quietBtn}>
              Open your services
            </Link>
          </div>
        </Card>

        <Card className="min-w-0 p-5">
          <h2 className="font-display text-lg">3. Your hours</h2>
          <Steps
            items={[
              <>Open your profile on Booksy, TheCut or Google and copy your opening hours.</>,
              <>
                Here, open {em("Calendar → Staff")} and tap {em("Hours")} next to your
                name.
              </>,
              <>
                Tap {em("Paste hours from another app")}, paste them and tap {em("Apply")}.
                Lines like &ldquo;Mon-Fri 9am-6pm&rdquo; or &ldquo;Sunday closed&rdquo;
                work; a lunch gap becomes a break.
              </>,
              <>Check the days it filled in, fix any line it couldn&apos;t read, then tap {em("Save hours")}.</>,
            ]}
          />
          <div className="mt-4">
            <Link href={hoursHref} className={quietBtn}>
              Open your hours
            </Link>
          </div>
        </Card>

        <Card className="min-w-0 p-5">
          <h2 className="font-display text-lg">4. Your reviews</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Booksy and TheCut don&apos;t let reviews be exported, and we won&apos;t
            copy them in by hand, because nobody could check that they&apos;re
            real. The quickest way back is to ask your regulars: send them this
            message from your own phone, or post it on Instagram. ChairBack
            doesn&apos;t send it for you. New reviews wait for your approval
            under Reviews before they show on your page.
          </p>
          <div className="mt-4">
            {pageLive && shop?.slug ? (
              <>
                {!reviewsShown && (
                  <p className="mb-3 rounded-xl border border-subtle bg-charcoal-700/50 p-3 text-xs leading-relaxed text-muted">
                    Reviews are switched off on your page right now, so this link
                    won&apos;t show the review form.{" "}
                    <Link href={pageHref} className="text-gold hover:underline">
                      Turn the Reviews section on
                    </Link>{" "}
                    first.
                  </p>
                )}
                <ReviewAsk appBase={appBase} slug={shop.slug} shopName={shop.name} />
              </>
            ) : (
              <p className="text-sm leading-relaxed text-muted">
                {shop
                  ? "Your page isn't live yet, so there's no review link to send. "
                  : "Couldn't load your page details. Refresh to try again, or "}
                <Link href={pageHref} className="text-gold hover:underline">
                  {shop ? "Set up your page" : "open your page"}
                </Link>
                {shop ? " first." : "."}
              </p>
            )}
          </div>
        </Card>

        <Card className="min-w-0 p-5">
          <h2 className="font-display text-lg">Appointments already booked</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Appointment history doesn&apos;t come across. Booksy can&apos;t export it
            from the app, but Booksy support can email it to you if you ask.
            For bookings that haven&apos;t happened yet, keep your old account until
            they&apos;re done, and send those {vocab.clientNounPlural} your new
            booking link so their next visit is booked here.
          </p>
        </Card>
      </div>
    </main>
  );
}
