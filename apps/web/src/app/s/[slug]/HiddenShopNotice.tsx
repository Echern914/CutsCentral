import type { HiddenShop } from "./shopPage";

/**
 * What a client sees on a shop's link while the shop has hidden its page: the
 * shop's name and what that means, never "that page doesn't exist" - the link
 * is right, the shop switched its page off.
 */
export function hiddenShopHeading(shop: HiddenShop): string {
  return shop.booksHere
    ? `${shop.name} isn't taking online bookings right now`
    : `${shop.name}'s page isn't available right now`;
}

export function HiddenShopNotice({ shop }: { shop: HiddenShop }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-16 text-center text-offwhite">
      <h1 className="font-display text-3xl tracking-tight">{hiddenShopHeading(shop)}</h1>
      <p className="mt-3 text-sm text-muted">
        Your link is the right one. Check back later, or contact {shop.name} directly.
        {shop.booksHere && " An appointment you already have still stands."}
      </p>
    </main>
  );
}
