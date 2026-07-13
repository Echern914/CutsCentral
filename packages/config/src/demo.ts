/**
 * The DEMO shop: a real, fully-seeded tenant ("Fade District", slug `demo`)
 * that the guided client-experience tour runs over. These constants are the
 * contract between the seeder (apps/api/src/demo/seedDemoShop.ts), the nightly
 * reset job, and the web tour (apps/web/src/components/tour) — the tour builds
 * its cross-page links from the FIXED tokens below, so the seeder must always
 * restore rows carrying exactly these values.
 *
 * The tokens are deliberately public: the demo tenant holds no real customer
 * data, tour mode never writes, and the nightly reset restores canonical state,
 * so leaking them costs nothing. Never reuse this pattern for a real tenant.
 */
export const DEMO = {
  /** Shop.slug of the demo tenant — how every surface recognizes "demo mode". */
  SHOP_SLUG: "demo",
  /** Owner account; must stay in clean-fake-data.mjs KEEP_EMAILS. */
  OWNER_EMAIL: "demo@chairback.app",
  /** Twilio magic "valid" number — never routes to a real person. */
  CLIENT_PHONE: "+15005550006",
  /** Fixed Appointment.manageToken of the seeded showcase appointment. */
  MANAGE_TOKEN: "demo-manage-4f8a1c72e9b3d605a2c4",
  /** Fixed Client.magicToken of the seeded demo client (rewards page auth). */
  MAGIC_TOKEN: "demo-rewards-b91e57a3c40d268f7e13",
} as const;
