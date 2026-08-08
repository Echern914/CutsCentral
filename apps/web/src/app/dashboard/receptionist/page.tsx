import Link from "next/link";
import { apiGet } from "@/lib/api";
import { featureLocks, getBillingSummary } from "@/lib/billing";
import { Card } from "@/components/ui/Card";
import { CardHeader } from "@/components/ui/Card";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ReceptionistControls } from "../billing/ReceptionistControls";
import { UpgradeCallout } from "../_components/UpgradeCallout";

/**
 * The AI receptionist's own page.
 *
 * WHY THIS EXISTS: the controls used to live only inside /dashboard/billing.
 * Both in-app surfaces that could route a barber anywhere - the Cmd-K palette
 * (FeatureSearch) and the More sheet - strip every /dashboard/billing link to
 * comply with App Store Guideline 3.1.1. So the receptionist, the entire
 * justification for the top tier, appeared in NEITHER inside the iOS app. A
 * barber who paid for it could not find it on his phone.
 *
 * The controls themselves quote no price and expose no purchase mechanism
 * (that was already true - billing's own comment said "No price shown, so it
 * can render natively too"), so hosting them here is safe in-app. Everything
 * that SELLS stays on /dashboard/billing and stays hidden in the app.
 */
interface ShopSettings {
  receptionistEnabled: boolean;
  receptionistTermsAcceptedAt: string | null;
  bookingMode: string;
  twilioNumber: string | null;
}

export default async function ReceptionistPage() {
  // getBillingSummary replaces the page's own /api/billing round trip (it is
  // render-memoized and shared with the layout's lock computation).
  const shopRes = await apiGet<ShopSettings>("/api/shops/me");
  // Sequential on purpose — memoized fetch; keeps apiGet's generic intact
  // (the dual-React `cache` typing hole would otherwise any-poison the tuple).
  const res = await getBillingSummary();
  const shop = shopRes.data;
  const entitled = res.data?.receptionist.entitled ?? false;
  const locks = featureLocks(res);

  return (
    <div className="mx-auto max-w-3xl">
      <Card className="p-5">
        <CardHeader
          title="AI receptionist"
          subtitle="Answers your texts and books clients while you're behind the chair."
        />

        {entitled && shop ? (
          <div className="mt-4">
            <ReceptionistControls
              enabled={shop.receptionistEnabled}
              termsAccepted={shop.receptionistTermsAcceptedAt !== null}
              bookingMode={shop.bookingMode}
              shopNumber={shop.twilioNumber ?? null}
            />
          </div>
        ) : locks.premiumAi ? (
          /* LAPSED shop: the full diamond treatment (badge + web-only upgrade
             steering). Distinct from the fork below, which is a shop WITH
             access (trial/Premium) that simply hasn't added the AI tier — that
             one keeps the soft copy and no diamond, because a trialing shop
             must never see a lock. */
          <div className="mt-4">
            <UpgradeCallout tier="pro_ai">
              The AI receptionist answers your clients&apos; texts and books them
              in, 24/7 — it&apos;s part of the Premium AI plan.
            </UpgradeCallout>
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-subtle bg-charcoal-800 px-4 py-3 text-sm text-muted">
            <p>
              The AI receptionist isn&apos;t switched on for this shop yet. Once
              it is, this is where you turn it on and off and see the number
              clients text.
            </p>
            {/* The upgrade path is a PURCHASE mechanism, so it is web-only
                (Guideline 3.1.1). In the app this block simply ends here rather
                than dangling a link the shell would have to intercept. */}
            <HideInNativeApp>
              <p className="mt-2">
                <Link href="/dashboard/billing" className="text-gold hover:underline">
                  See plans and add it &rarr;
                </Link>
              </p>
            </HideInNativeApp>
          </div>
        )}

        <p className="mt-4 text-xs text-muted">
          Conversations it has with your clients show up in{" "}
          <Link href="/dashboard/inbox" className="text-gold hover:underline">
            Inbox
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
