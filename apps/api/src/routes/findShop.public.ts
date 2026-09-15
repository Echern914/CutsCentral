import { Router } from "express";
import { findShopByHandle } from "../services/shopByHandle.js";

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
 * The lookup itself lives in services/shopByHandle.ts, because "Add to my
 * shops" must use exactly this one and no other.
 *
 * ── What comes back ─────────────────────────────────────────────────────────
 *
 * Only what the shop's own public page already shows anybody who opens it:
 * name, logo, town. No phone, no email, no address line, no owner, no counts,
 * nothing about clients - and not the internal id. Finding a shop must never
 * reveal more than visiting it would.
 */
export const findShopRouter = Router();

findShopRouter.get("/", async (req, res) => {
  const raw = typeof req.query.handle === "string" ? req.query.handle : "";
  const shop = await findShopByHandle(raw);

  // 🔴 ONE REFUSAL FOR EVERY MISS. Unparseable input, a handle nobody has, and
  // a shop that has switched its public page off all answer identically. Three
  // different answers here would let someone tell "that shop exists but is
  // private" from "that shop does not exist", which is a fact about a real
  // business that we have no business handing out.
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.json({
    shop: {
      name: shop.name,
      handle: shop.handle,
      logoUrl: shop.logoUrl,
      town: shop.town,
      pageUrl: shop.pageUrl,
      bookUrl: shop.bookUrl,
    },
  });
});
