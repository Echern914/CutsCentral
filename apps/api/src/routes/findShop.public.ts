import { Router } from "express";
import { apiEnv, normalizeShopHandle } from "@chairback/config";
import { prisma } from "@chairback/db";

/**
 * Find one shop by its exact handle.
 *
 * ── 🔴 WHY THIS IS A LOOKUP AND NOT A SEARCH ────────────────────────────────
 *
 * A customer who has lost the link their barber texted them needs a way back
 * in that does not involve the barber. The obvious build - a search box over
 * shop names - is the wrong one: it turns every shop on the platform into a
 * browsable directory. A rival could list the neighbourhood, a stranger could
 * scroll for shops by name, and a shop that never asked to be discoverable
 * becomes discoverable.
 *
 * So this resolves an EXACT handle and nothing else. `drickcuttinup` finds
 * Drick's shop; `drick` finds nothing; `drickcuttinu` finds nothing. There is
 * no prefix match, no contains, no fuzzy repair, no "did you mean", and no
 * endpoint that returns more than one shop. You can only arrive here already
 * knowing the handle - which is exactly the position you are in holding a
 * link, and that is the point.
 *
 * What it IS forgiving about is the shape of what gets typed: capitals, a
 * leading @, or the whole pasted URL all resolve, because those are the same
 * knowledge wearing different clothes. See normalizeShopHandle.
 *
 * ── What comes back ─────────────────────────────────────────────────────────
 *
 * Only what the shop's own public page already shows anybody who opens it:
 * name, logo, town. No phone, no email, no address line, no owner, no counts,
 * nothing about clients. Finding a shop must never reveal more than visiting
 * it would.
 */
export const findShopRouter = Router();

const env = apiEnv();

findShopRouter.get("/", async (req, res) => {
  const raw = typeof req.query.handle === "string" ? req.query.handle : "";
  const handle = normalizeShopHandle(raw);

  // 🔴 ONE REFUSAL FOR EVERY MISS. Unparseable input, a handle nobody has, and
  // a shop that has switched its public page off all answer identically. Three
  // different answers here would let someone tell "that shop exists but is
  // private" from "that shop does not exist", which is a fact about a real
  // business that we have no business handing out.
  const miss = () => res.status(404).json({ error: "not_found" });

  if (!handle) return miss();

  const shop = await prisma.shop.findUnique({
    where: { slug: handle },
    select: {
      name: true,
      slug: true,
      logoUrl: true,
      addressCity: true,
      addressRegion: true,
      publicPageEnabled: true,
      bookingMode: true,
      bookingUrl: true,
    },
  });
  if (!shop || !shop.publicPageEnabled || !shop.slug) return miss();

  // Where to send them. A native shop books here; a shop whose calendar lives
  // in Acuity or Square books at its own link, and if it has not set one, the
  // public page is still the right destination.
  const pageUrl = `${env.APP_BASE_URL}/s/${shop.slug}`;
  const bookUrl =
    shop.bookingMode === "native"
      ? `${env.APP_BASE_URL}/book/${shop.slug}`
      : (shop.bookingUrl ?? pageUrl);

  res.json({
    shop: {
      name: shop.name,
      handle: shop.slug,
      logoUrl: shop.logoUrl,
      // The town, so someone with the right handle can confirm it is the shop
      // they meant. Never the street address - that is a level of detail the
      // public page itself does not print.
      town:
        shop.addressCity && shop.addressRegion
          ? `${shop.addressCity}, ${shop.addressRegion}`
          : (shop.addressCity ?? null),
      pageUrl,
      bookUrl,
    },
  });
});
