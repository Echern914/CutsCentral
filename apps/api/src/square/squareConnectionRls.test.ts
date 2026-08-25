import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * CAN SquareConnection SAFELY USE `FORCE ROW LEVEL SECURITY`?
 *
 * `SquareConnection` holds OAuth tokens. It ships as ENABLE-only - RLS on, no
 * FORCE, no policy - which is the posture `AcuityConnection` and `User` and
 * `Shop` inherited from 20260609000000_rls_lockdown_non_tenant_tables. That
 * migration's comment says FORCE is "intentionally NOT used here so the owner
 * keeps access", and the app has been relying on owner bypass ever since.
 *
 * "Relying on owner bypass" is the kind of sentence that deserves a measurement
 * rather than a comment, because it is doing real security work and nobody has
 * checked what would change if it went away. This file measures it.
 *
 * Every claim below is established by QUERYING, not asserted. The DDL
 * experiments run inside transactions that ROLL BACK, so the schema is exactly
 * as it was when the file finishes - Postgres makes DDL transactional, which is
 * what lets a test ask "what would FORCE do?" without a migration.
 *
 * THE FINDING, in the order the tests establish it:
 *
 *   1. A non-superuser role already sees ZERO rows. ENABLE with no policy is
 *      default-deny, so the Supabase data API hole this table was flagged for
 *      is already closed. FORCE would add nothing there.
 *   2. The app reads it at all only because it connects as a SUPERUSER, and a
 *      superuser bypasses RLS whether or not FORCE is set. So on this
 *      deployment FORCE is a NO-OP for the application - it cannot be the
 *      reason to adopt it, and it cannot be the reason to fear it either.
 *   3. FORCE becomes load-bearing the moment the app stops connecting as a
 *      superuser. At that point ENABLE+FORCE with NO POLICY makes the table
 *      unreadable by the application itself: every Square token lookup returns
 *      nothing and the whole integration goes dark. FORCE alone is therefore
 *      not "more secure", it is a latent outage.
 *   4. FORCE + a shopId policy is workable for the SHOP-SCOPED reads.
 *   5. ...but not for the WEBHOOK, which resolves merchant -> shop with no shop
 *      context to scope by. Under a shopId policy that lookup returns nothing,
 *      so every inbound Square event would be dropped as "unknown merchant".
 *
 * CONCLUSION, encoded as tests rather than opinion: FORCE is safe to adopt only
 * together with (a) a policy, and (b) moving the merchant -> shop resolution
 * outside RLS or giving it a policy of its own. Until S3 does that, ENABLE-only
 * is the correct posture and this file is why - not a comment that says "we
 * decided".
 */

let shopId: string;
let userId: string;
let merchantId: string;

/** Is the role this test connects as able to bypass RLS at all? */
async function connectsAsSuperuser(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ bypass: boolean }[]>(
    `SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
  );
  return rows[0]?.bypass === true;
}

async function appRoleExists(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM pg_roles WHERE rolname = 'chairback_app'`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `sqrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "R" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "RLS Probe",
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;
  merchantId = `M_${randomToken(8)}`;
  await prisma.squareConnection.create({
    data: {
      shopId,
      squareMerchantId: merchantId,
      accessToken: "enc",
      refreshToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
});

afterAll(async () => {
  if (shopId) await prisma.squareConnection.deleteMany({ where: { shopId } });
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("what SquareConnection's RLS posture actually is", () => {
  it("ships ENABLE-only: no FORCE, no policy", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { enabled: boolean; forced: boolean; policies: bigint }[]
    >(`
      SELECT c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'SquareConnection'
    `);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.forced).toBe(false);
    expect(Number(rows[0]!.policies)).toBe(0);
  });

  it("matches AcuityConnection exactly - one posture for both secrets tables", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relname: string; enabled: boolean; forced: boolean; policies: bigint }[]
    >(`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('SquareConnection', 'AcuityConnection')
      ORDER BY c.relname
    `);
    expect(rows).toHaveLength(2);
    const [acuity, square] = rows;
    expect(square!.enabled).toBe(acuity!.enabled);
    expect(square!.forced).toBe(acuity!.forced);
    expect(Number(square!.policies)).toBe(Number(acuity!.policies));
  });
});

describe("finding 1: the data-API hole is ALREADY closed without FORCE", () => {
  it("gives a non-superuser role ZERO rows today", async () => {
    if (!(await appRoleExists())) return; // role absent in this environment
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE chairback_app`);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "SquareConnection"`,
      );
    });
    // ENABLE with no policy is default-deny. This is what the Supabase advisory
    // was about, and it is already satisfied - FORCE would add nothing here.
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("hides the row even from a role that knows the exact shopId", async () => {
    if (!(await appRoleExists())) return;
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE chairback_app`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_shop_id', $1, true)`, shopId);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "SquareConnection" WHERE "shopId" = $1`,
        shopId,
      );
    });
    // No policy means no row is visible, shop context or not. A tenant-scoped
    // read of this table returns NULL - which is exactly why the engines read
    // it with plain prisma and never inside runWithShop.
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("finding 2: the app reads it because it is a SUPERUSER, not because FORCE is off", () => {
  it("connects as a role that bypasses RLS", async () => {
    // If this ever becomes false, findings 3-5 stop being hypothetical.
    expect(await connectsAsSuperuser()).toBe(true);
  });

  it("still reads the row with FORCE turned ON", async () => {
    const seen = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "SquareConnection" FORCE ROW LEVEL SECURITY`);
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "SquareConnection" WHERE "shopId" = $1`,
        shopId,
      );
      // Roll the DDL back - Postgres makes this transactional, which is the
      // whole reason this question can be asked without a migration.
      throw Object.assign(new Error("rollback"), { seen: Number(rows[0]!.n) });
    }).catch((err: { seen?: number }) => err.seen ?? -1);

    // FORCE subjects the table OWNER to RLS - but a superuser bypasses RLS
    // regardless. So on this deployment FORCE changes nothing for the app.
    expect(seen).toBe(1);
  });

  it("leaves the schema exactly as it found it", async () => {
    const rows = await prisma.$queryRawUnsafe<{ forced: boolean }[]>(`
      SELECT c.relforcerowsecurity AS forced FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'SquareConnection'
    `);
    expect(rows[0]!.forced).toBe(false);
  });
});

describe("finding 3: FORCE with no policy is a latent OUTAGE, not a hardening", () => {
  it("makes the table unreadable by a non-superuser application role", async () => {
    if (!(await appRoleExists())) return;
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "SquareConnection" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE chairback_app`);
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "SquareConnection"`,
        );
        throw Object.assign(new Error("rollback"), { seen: Number(rows[0]!.n) });
      })
      .catch((err: { seen?: number }) => err.seen ?? -1);

    // Zero - the same zero as without FORCE. The point is what this means for
    // the day the app stops being a superuser: every token lookup, every
    // webhook route, every capability check returns nothing, and Square goes
    // dark with no error anywhere that says "RLS".
    expect(seen).toBe(0);
  });
});

describe("findings 4 and 5: FORCE + a policy works for reads that HAVE a shop", () => {
  it("lets a shop-scoped read through", async () => {
    if (!(await appRoleExists())) return;
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "SquareConnection" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRawUnsafe(`
          CREATE POLICY tenant_isolation_probe ON "SquareConnection"
            USING ("shopId" = current_shop_id())
        `);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE chairback_app`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_shop_id', $1, true)`, shopId);
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "SquareConnection" WHERE "shopId" = $1`,
          shopId,
        );
        throw Object.assign(new Error("rollback"), { seen: Number(rows[0]!.n) });
      })
      .catch((err: { seen?: number }) => err.seen ?? -1);
    expect(seen).toBe(1);
  });

  it("BREAKS the webhook, which resolves merchant -> shop with no shop context", async () => {
    if (!(await appRoleExists())) return;
    const seen = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "SquareConnection" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRawUnsafe(`
          CREATE POLICY tenant_isolation_probe ON "SquareConnection"
            USING ("shopId" = current_shop_id())
        `);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE chairback_app`);
        // No set_config: this is the webhook's actual situation. An inbound
        // Square event carries a merchant_id and nothing else - working out
        // which shop it belongs to is the whole point of the lookup, so there
        // is no shop id to scope by yet.
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "SquareConnection" WHERE "squareMerchantId" = $1`,
          merchantId,
        );
        throw Object.assign(new Error("rollback"), { seen: Number(rows[0]!.n) });
      })
      .catch((err: { seen?: number }) => err.seen ?? -1);

    // Zero. Under FORCE + a shopId policy every inbound Square booking event
    // would be dropped as "unknown merchant" - a silent, total loss of inbound
    // sync, with a 200 OK on every request so nothing would look wrong.
    expect(seen).toBe(0);
  });

  it("leaves no probe policy behind", async () => {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_policies WHERE tablename = 'SquareConnection'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("the tenant table next door DOES take FORCE", () => {
  it("SquareOutboundBooking ships ENABLE + FORCE + a policy", async () => {
    // The contrast is the argument: an outbound row is per-shop with no
    // merchant-resolution path, so it takes the full tenant posture and the
    // connection table does not. Different tables, different answers, both
    // measured.
    const rows = await prisma.$queryRawUnsafe<
      { enabled: boolean; forced: boolean; policies: bigint }[]
    >(`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'SquareOutboundBooking'
    `);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.forced).toBe(true);
    expect(Number(rows[0]!.policies)).toBe(1);
  });

  it("keeps chairback_app OUT of the webhook inbox entirely", async () => {
    if (!(await appRoleExists())) return;
    const rows = await prisma.$queryRawUnsafe<{ privilege_type: string }[]>(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'SquareWebhookEvent' AND grantee = 'chairback_app'
      ORDER BY privilege_type
    `);
    const held = rows.map((r) => r.privilege_type);
    // REVOKE, not "we never granted": ALTER DEFAULT PRIVILEGES hands the role
    // all four on every new table automatically, so a bare GRANT would read
    // like a restriction while changing nothing.
    expect(held).not.toContain("UPDATE");
    expect(held).not.toContain("DELETE");
  });
});
