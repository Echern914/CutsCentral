"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { getShopQrAction, type ShopQr } from "./qrActions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "Scan to book" - the shop's own QR code, for the mirror, the window, or a
 * card in someone's wallet.
 *
 * It encodes the shop's PUBLIC BOOKING URL, so one scan lands a stranger on the
 * page where they pick a service and a time. Each shop's code is unique because
 * the URL is: there is nothing to configure and nothing to get wrong.
 *
 * Generated on demand rather than on every dashboard load - the barber opens
 * this once, prints it, and never thinks about it again.
 *
 * PRINTING is a print stylesheet, not a PDF library. `window.print()` on a page
 * whose @media print rules hide everything except the card gives a real,
 * paper-sized result with no dependency and no server round trip.
 */
export function ShopQrCard({
  bookUrl,
  shopName,
  toast,
}: {
  bookUrl: string;
  shopName: string;
  toast: Toast;
}) {
  const [qr, setQr] = useState<ShopQr | null>(null);
  const [pending, start] = useTransition();

  function generate() {
    start(async () => {
      const res = await getShopQrAction(bookUrl);
      if (res.ok) setQr(res.qr);
      else toast("Couldn't build your QR code", "error");
    });
  }

  return (
    <Card className="p-5">
      <h3 className="font-display text-base">Your QR code</h3>
      <p className="mt-1 text-sm text-muted">
        Stick it on the mirror or the window. One scan opens your booking page —
        no app, no account, no typing a link.
      </p>

      {!qr ? (
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
        >
          {pending ? "Building…" : "Show my QR code"}
        </button>
      ) : (
        <>
          {/* The printable artifact. Everything inside #cb-qr-print survives
              printing; the rest of the dashboard is hidden by the rules below. */}
          <div
            id="cb-qr-print"
            className="mt-4 flex w-fit flex-col items-center gap-3 rounded-2xl bg-white p-6 text-center"
          >
            <p className="font-display text-xl font-semibold text-black">{shopName}</p>
            <p className="text-sm font-medium tracking-wide text-black">SCAN TO BOOK</p>
            {/* Inline SVG: vector, so it prints crisp at any size. The library
                emits a plain <svg>, and the string is ours (built from a URL we
                validated server-side), never user markup. */}
            <div
              className="h-56 w-56 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: qr.svg }}
              role="img"
              aria-label={`QR code linking to ${qr.url}`}
            />
            <p className="max-w-56 break-all text-[11px] text-neutral-600">
              {qr.url.replace(/^https?:\/\//, "")}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href={qr.png}
              download={`${slugify(shopName)}-booking-qr.png`}
              className="rounded-lg bg-gold/15 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/25"
            >
              Download PNG
            </a>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border border-subtle px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-offwhite"
            >
              Print card
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(qr.url)
                  .then(() => toast("Link copied", "success"))
                  .catch(() => toast("Couldn't copy", "error"));
              }}
              className="rounded-lg border border-subtle px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-offwhite"
            >
              Copy link
            </button>
          </div>

          {/* Print rules live with the thing they print. Hiding BODY children
              and un-hiding the card's ancestor chain is what stops the sidebar,
              the nav and the rest of the tab landing on the page. */}
          <style>{`
            @media print {
              body * { visibility: hidden !important; }
              #cb-qr-print, #cb-qr-print * { visibility: visible !important; }
              #cb-qr-print {
                position: absolute !important;
                left: 50% !important;
                top: 40px !important;
                transform: translateX(-50%) !important;
                background: #fff !important;
                padding: 32px !important;
              }
            }
          `}</style>
        </>
      )}
    </Card>
  );
}

/** "Drick's Barbershop" -> "dricks-barbershop", for the download filename. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "shop"
  );
}
