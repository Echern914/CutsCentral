import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, READ_SCOPES } from "@chairback/config";
import { TOOL_POLICIES } from "../mcp/toolPolicy.js";
import { TOOL_DEFINITIONS } from "../mcp/tools/index.js";

/**
 * THE READ-ONLY TOOLS, END TO END, THROUGH A REAL BEARER TOKEN.
 *
 * toolPolicy.test.ts asserts the matrix as a pure function. This file asserts
 * that the matrix is what actually happens over HTTP — that the router consults
 * it, that a barber really cannot read a colleague's chair, and that no handler
 * quietly returns a phone number.
 *
 * 🔴 THE LAPSED CASE IS MOCKED, AND HAS TO BE. `hasActiveAccess` returns true
 * whenever billing is unconfigured, which is how the entire suite runs — so a
 * "lapsed shop" is unreachable here without either configuring Stripe or
 * controlling that one function. Controlling it is the honest option: it makes
 * the wall testable rather than assumed.
 */

const billing = vi.hoisted(() => ({ active: true }));
vi.mock("../billing/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/stripe.js")>();
  return { ...actual, hasActiveAccess: () => billing.active };
});

const { createApp } = await import("../app.js");
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];
const REDIRECT = "https://tools.example/cb/callback";

let shopId: string;
let chairA: string; // the barber's own chair
let chairB: string; // a colleague's
let serviceId: string;
let clientId: string;

let ownerToken: string;
let managerToken: string;
let barberToken: string;
let seatlessToken: string;
let helpOnlyToken: string;
/** A second shop entirely, for the cross-tenant check. */
let otherShopToken: string;
let otherShopId: string;

interface Seat {
  cookie: string;
  userId: string;
}

async function signup(label: string): Promise<Seat> {
  const email = `mcpt-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

/** One full OAuth round trip for a seat, at the scopes asked for. */
async function connect(seat: Seat, scopes: readonly string[] = READ_SCOPES): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

  const reg = await request(app)
    .post("/mcp/oauth/register")
    .send({ client_name: "Tools Test Client", redirect_uris: [REDIRECT] });
  expect(reg.status).toBe(201);
  const cid = reg.body.client_id as string;

  const approve = await request(app)
    .post("/mcp/oauth/authorize/approve")
    .set("Cookie", seat.cookie)
    .send({
      client_id: cid,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      scope: scopes.join(" "),
    });
  expect(approve.status).toBe(200);
  const code = new URL(approve.body.redirect_to).searchParams.get("code")!;

  const tok = await request(app).post("/mcp/oauth/token").send({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: cid,
  });
  expect(tok.status).toBe(200);
  return tok.body.access_token as string;
}

const rpc = (token: string, method: string, params?: unknown) =>
  request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

async function listTools(token: string): Promise<string[]> {
  const res = await rpc(token, "tools/list");
  expect(res.status).toBe(200);
  return (res.body.result.tools as { name: string }[]).map((t) => t.name).sort();
}

interface CallResult {
  isError: boolean;
  text: string;
  data: Record<string, unknown> | null;
}

async function call(token: string, name: string, args?: unknown): Promise<CallResult> {
  const res = await rpc(token, "tools/call", { name, arguments: args ?? {} });
  expect(res.status).toBe(200);
  const result = res.body.result;
  return {
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? "",
    data: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
  };
}

/** Today, in the UTC test shop, as YYYY-MM-DD. */
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayAtUtc = (hour: number) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

beforeAll(async () => {
  const owner = await signup("owner");
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: "Tools Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", owner.cookie)
    .send({ bookingMode: "native", timezone: "UTC" });

  const a = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", owner.cookie)
    .send({ name: "Dev" });
  chairA = a.body.id;
  const b = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", owner.cookie)
    .send({ name: "Marcus" });
  chairB = b.body.id;

  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", owner.cookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA, chairB] });
  serviceId = svc.body.id;

  // A client carrying every field the tools must NOT return.
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `mcpt-${randomToken(6)}`,
      firstName: "Ricky",
      lastName: "Tomlinson",
      phone: "+15550001111",
      email: "ricky@example.test",
      notes: "PRIVATE BARBER NOTE",
      magicToken: randomToken(16),
      lastVisitAt: new Date(Date.now() - 40 * 86_400_000),
    },
  });
  clientId = client.id;

  // One appointment on each chair, so chair scoping has something to get wrong.
  for (const [staffId, who] of [
    [chairA, "Adam"],
    [chairB, "Bella"],
  ] as const) {
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: who,
        lastName: "Colleague",
        phone: "+15550002222",
        email: "appt@example.test",
        notes: "PRIVATE APPOINTMENT NOTE",
        status: "BOOKED",
        startsAt: todayAtUtc(14),
        endsAt: new Date(todayAtUtc(14).getTime() + 30 * 60_000),
        manageToken: randomToken(16),
      },
    });
  }

  await prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: "Wanda",
      lastName: "Waiting",
      phone: "+15550003333",
      email: "wanda@example.test",
      note: "PRIVATE WAITLIST NOTE",
      serviceId,
      staffId: chairA,
      preferredTime: "Saturday morning",
      status: "WAITING",
    },
  });

  const manager = await signup("manager");
  await prisma.shopMember.create({
    data: { shopId, userId: manager.userId, role: "MANAGER", staffId: null },
  });
  const barber = await signup("barber");
  await prisma.shopMember.create({
    data: { shopId, userId: barber.userId, role: "BARBER", staffId: chairA },
  });
  const seatless = await signup("seatless");
  await prisma.shopMember.create({
    data: { shopId, userId: seatless.userId, role: "BARBER", staffId: null },
  });

  ownerToken = await connect(owner);
  managerToken = await connect(manager);
  barberToken = await connect(barber);
  seatlessToken = await connect(seatless);
  helpOnlyToken = await connect(owner, ["chairback:help:read"]);

  // An unrelated shop with its own owner, for tenant isolation.
  const stranger = await signup("stranger");
  const other = await request(app)
    .post("/api/shops")
    .set("Cookie", stranger.cookie)
    .send({ name: "Other Cuts", smsAttested: true });
  otherShopId = other.body.id;
  otherShopToken = await connect(stranger);
});

afterAll(async () => {
  billing.active = true;
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.mcpClient.deleteMany({ where: { clientName: "Tools Test Client" } });
});

describe("the registry and the policy table agree", () => {
  it("every handler has a policy and every policy has a handler", () => {
    // 🔴 THE DEFAULT-DENY GUARANTEE, checked in both directions. A handler with
    // no policy is unreachable (good, but dead); a policy with no handler is a
    // tool advertised and then refused. Neither may ship.
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
      TOOL_POLICIES.map((p) => p.name).sort(),
    );
  });

  it("every input schema refuses unknown properties", () => {
    // additionalProperties:false is what makes "there is no staffId parameter"
    // a refusal rather than a silently ignored field.
    for (const def of TOOL_DEFINITIONS) {
      expect(def.inputSchema.additionalProperties, def.name).toBe(false);
      expect(def.inputSchema.type, def.name).toBe("object");
    }
  });
});

describe("tools/list is scoped to the caller", () => {
  it("an owner with full consent sees every tool", async () => {
    expect(await listTools(ownerToken)).toEqual(TOOL_POLICIES.map((p) => p.name).sort());
  });

  it("a barber sees only their own-chair and help tools", async () => {
    expect(await listTools(barberToken)).toEqual([
      "calendar_agenda",
      "calendar_openings",
      "help_find_feature",
      "help_list_features",
      "readiness_report",
    ]);
  });

  it("consent narrows the list", async () => {
    expect(await listTools(helpOnlyToken)).toEqual(["help_find_feature", "help_list_features"]);
  });

  it("the server advertises a tools capability now that it has tools", async () => {
    const res = await rpc(ownerToken, "initialize");
    expect(res.body.result.capabilities.tools).toEqual({ listChanged: false });
  });
});

describe("every tool answers for the seat that may call it", () => {
  const today = ymd(new Date());

  it("help_find_feature resolves through the registry, never a raw path", async () => {
    // "deposit" is a synonym on the payments entry. A multi-word phrase would
    // be a worse test than it looks: searchFeatures REQUIRES every literally
    // typed token to hit, so one stray word ("take") returns nothing and the
    // test would be asserting the matcher's strictness, not the tool's wiring.
    const r = await call(ownerToken, "help_find_feature", { query: "deposit" });
    expect(r.isError).toBe(false);
    const features = (r.data!.features as { id: string; href: string | null }[]) ?? [];
    expect(features.length).toBeGreaterThan(0);
    // Every href came from resolveFeature, so every one is a real dashboard path.
    for (const f of features) {
      if (f.href) expect(f.href.startsWith("/")).toBe(true);
    }
  });

  it("help_list_features is available and lists categories", async () => {
    const r = await call(ownerToken, "help_list_features");
    expect(r.isError).toBe(false);
    expect((r.data!.categories as unknown[]).length).toBeGreaterThan(0);
  });

  it("readiness_report gives an owner the shop and a barber their chair", async () => {
    const owner = await call(ownerToken, "readiness_report");
    expect(owner.isError).toBe(false);
    expect(owner.data!.scope).toBe("shop");

    const barber = await call(barberToken, "readiness_report");
    expect(barber.isError).toBe(false);
    expect(barber.data!.scope).toBe("chair");
    expect((barber.data!.chair as { staffId: string }).staffId).toBe(chairA);
  });

  it("calendar_agenda returns the day", async () => {
    const r = await call(ownerToken, "calendar_agenda", { from: today });
    expect(r.isError).toBe(false);
    expect((r.data!.appointments as unknown[]).length).toBe(2);
  });

  it("calendar_openings plans a day", async () => {
    const r = await call(ownerToken, "calendar_openings", { from: today });
    expect(r.isError).toBe(false);
    expect(Array.isArray(r.data!.openings)).toBe(true);
  });

  it("clients_search and client_detail answer", async () => {
    const search = await call(ownerToken, "clients_search", { query: "Ricky" });
    expect(search.isError).toBe(false);
    expect((search.data!.clients as { id: string }[]).some((c) => c.id === clientId)).toBe(true);

    const detail = await call(ownerToken, "client_detail", { clientId });
    expect(detail.isError).toBe(false);
    expect((detail.data!.client as { id: string }).id).toBe(clientId);
  });

  it("waitlist_list answers", async () => {
    const r = await call(ownerToken, "waitlist_list");
    expect(r.isError).toBe(false);
    const entries = r.data!.entries as { preferredTime: string; wants: string }[];
    expect(entries.length).toBe(1);
    expect(entries[0]!.preferredTime).toBe("Saturday morning");
    expect(entries[0]!.wants).toBe("Fade");
  });

  it("business_summary answers", async () => {
    const r = await call(ownerToken, "business_summary", { from: today, to: today });
    expect(r.isError).toBe(false);
    expect((r.data!.appointments as { booked: number }).booked).toBe(2);
  });

  it("integration_health answers and never claims Square chair mapping", async () => {
    const r = await call(ownerToken, "integration_health");
    expect(r.isError).toBe(false);
    // A shop with no Square connection says so rather than inventing health.
    expect((r.data!.square as { connected: boolean }).connected).toBe(false);
  });

  it("a manager gets the whole shop, like the dashboard", async () => {
    const r = await call(managerToken, "calendar_agenda", { from: today });
    expect(r.isError).toBe(false);
    expect((r.data!.appointments as unknown[]).length).toBe(2);
    expect(r.data!.scope).toBe("shop");
  });
});

describe("🔴 a barber sees their own chair and no other", () => {
  const today = ymd(new Date());

  it("the agenda is narrowed to their chair", async () => {
    const r = await call(barberToken, "calendar_agenda", { from: today });
    expect(r.isError).toBe(false);
    expect(r.data!.scope).toBe("chair");
    const appts = r.data!.appointments as { staffId: string; client: string }[];
    expect(appts.length).toBe(1);
    expect(appts[0]!.staffId).toBe(chairA);
    // The colleague's booking is absent, not merely unlabelled.
    expect(appts.some((a) => a.staffId === chairB)).toBe(false);
  });

  it("there is no staffId parameter to widen it with", async () => {
    // The attack the barber router's header comment warns about: change a
    // parameter, read a colleague's book. The schema is strict, so the
    // parameter does not exist and asking for it is refused outright.
    const r = await call(barberToken, "calendar_agenda", { from: today, staffId: chairB });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/aren't valid/i);
  });

  it("openings are narrowed to their chair too", async () => {
    const r = await call(barberToken, "calendar_openings", { from: today });
    expect(r.isError).toBe(false);
    const slots = (r.data!.openings as { staffId: string }[]) ?? [];
    for (const s of slots) expect(s.staffId).toBe(chairA);
  });

  it("shop-wide tools are refused by role", async () => {
    for (const name of ["waitlist_list", "business_summary", "clients_search", "client_detail"]) {
      const r = await call(barberToken, name, name === "client_detail" ? { clientId } : {});
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/manager-only/i);
    }
  });

  it("a barber with no chair is refused rather than shown the shop", async () => {
    const r = await call(seatlessToken, "calendar_agenda", { from: today });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/isn't linked to a chair/i);
  });
});

describe("🔴 no tool returns customer contact details", () => {
  const today = ymd(new Date());

  it("nothing anywhere echoes a phone, an email or a private note", async () => {
    // Every field deliberately planted in the fixtures, checked against the
    // RAW response body of every tool an owner can call.
    const forbidden = [
      "+15550001111",
      "+15550002222",
      "+15550003333",
      "ricky@example.test",
      "appt@example.test",
      "wanda@example.test",
      "PRIVATE BARBER NOTE",
      "PRIVATE APPOINTMENT NOTE",
      "PRIVATE WAITLIST NOTE",
      // Surnames are reduced to an initial, so the full name must not appear.
      "Tomlinson",
      "Waiting",
    ];

    const calls: [string, unknown][] = [
      ["help_find_feature", { query: "clients" }],
      ["help_list_features", {}],
      ["readiness_report", {}],
      ["clients_search", { query: "Ricky" }],
      ["client_detail", { clientId }],
      ["calendar_agenda", { from: today }],
      ["calendar_openings", { from: today }],
      ["waitlist_list", {}],
      ["business_summary", { from: today, to: today }],
      ["integration_health", {}],
    ];

    for (const [name, args] of calls) {
      const res = await rpc(ownerToken, "tools/call", { name, arguments: args });
      const body = JSON.stringify(res.body);
      for (const secret of forbidden) {
        expect(body.includes(secret), `${name} leaked ${secret}`).toBe(false);
      }
    }
  });

  it("a client is still identifiable enough to be useful", async () => {
    const r = await call(ownerToken, "clients_search", { query: "Ricky" });
    const found = (r.data!.clients as { id: string; name: string }[]).find(
      (c) => c.id === clientId,
    );
    expect(found!.name).toBe("Ricky T.");
  });
});

describe("default deny over the wire", () => {
  it("an unknown tool is refused", async () => {
    const r = await call(ownerToken, "clients_export_everything");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no such tool/i);
  });

  it("a non-string tool name is refused rather than coerced", async () => {
    const r = await call(ownerToken, { name: "clients_search" } as unknown as string);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no such tool/i);
  });

  it("tools/call with no params is a JSON-RPC error", async () => {
    const res = await rpc(ownerToken, "tools/call");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });

  it("a scope that was never granted is refused, however senior the caller", async () => {
    const r = await call(helpOnlyToken, "clients_search", { query: "Ricky" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/wasn't given permission/i);
  });
});

describe("🔴 tenant isolation", () => {
  const today = ymd(new Date());

  it("another shop's token reads its own empty shop, not this one", async () => {
    const r = await call(otherShopToken, "calendar_agenda", { from: today });
    expect(r.isError).toBe(false);
    expect((r.data!.appointments as unknown[]).length).toBe(0);
    expect(otherShopId).not.toBe(shopId);
  });

  it("a client id from another shop does not resolve", async () => {
    // The id is real and correct - it just belongs to somebody else.
    const r = await call(otherShopToken, "client_detail", { clientId });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no client by that id/i);
  });

  it("a service id from another shop selects nothing rather than reaching", async () => {
    const r = await call(otherShopToken, "calendar_openings", { from: today, serviceId });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no active service/i);
  });
});

describe("🔴 the wall, per tool", () => {
  const today = ymd(new Date());

  it("a lapsed shop keeps help, readiness and its own client book", async () => {
    billing.active = false;
    try {
      expect(await listTools(ownerToken)).toEqual([
        "client_detail",
        "clients_search",
        "help_find_feature",
        "help_list_features",
        "readiness_report",
      ]);

      // And they genuinely work, rather than merely being listed.
      expect((await call(ownerToken, "readiness_report")).isError).toBe(false);
      expect((await call(ownerToken, "clients_search", { query: "Ricky" })).isError).toBe(false);
      expect((await call(ownerToken, "client_detail", { clientId })).isError).toBe(false);
      expect((await call(ownerToken, "help_find_feature", { query: "billing" })).isError).toBe(
        false,
      );
    } finally {
      billing.active = true;
    }
  });

  it("a lapsed shop loses the calendar, waitlist, insights and integrations", async () => {
    billing.active = false;
    try {
      for (const [name, args] of [
        ["calendar_agenda", { from: today }],
        ["calendar_openings", { from: today }],
        ["waitlist_list", {}],
        ["business_summary", { from: today, to: today }],
        ["integration_health", {}],
      ] as [string, unknown][]) {
        const r = await call(ownerToken, name, args);
        expect(r.isError, name).toBe(true);
        expect(r.text, name).toMatch(/plan has ended/i);
      }
    } finally {
      billing.active = true;
    }
  });

  it("a lapsed barber can still ask why the shop stopped working", async () => {
    billing.active = false;
    try {
      const r = await call(barberToken, "readiness_report");
      expect(r.isError).toBe(false);
      expect(r.data!.scope).toBe("chair");
    } finally {
      billing.active = true;
    }
  });
});

describe("the audit trail", () => {
  it("records a successful call by tool name, with no arguments", async () => {
    await call(ownerToken, "waitlist_list");
    const row = await prisma.mcpAuditEvent.findFirst({
      where: { shopId, toolName: "waitlist_list", result: "OK" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row!.operationType).toBe("READ");
    expect(row!.resourceType).toBe("waitlist");
    expect(row!.failureCode).toBeNull();
  });

  it("records a denial with the reason", async () => {
    await call(barberToken, "business_summary", { from: "2026-01-01", to: "2026-01-02" });
    const row = await prisma.mcpAuditEvent.findFirst({
      where: { shopId, toolName: "business_summary", result: "DENIED" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row!.failureCode).toBe("role");
  });

  it("🔴 does not store the name a caller made up", async () => {
    // An unknown tool name is attacker-controlled text. It is counted, not kept.
    await call(ownerToken, "drop_table_clients");
    const row = await prisma.mcpAuditEvent.findFirst({
      where: { shopId, result: "DENIED", failureCode: "unknown_tool" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row!.toolName).toBe("unknown_tool");
    const any = await prisma.mcpAuditEvent.count({
      where: { shopId, toolName: { contains: "drop_table" } },
    });
    expect(any).toBe(0);
  });
});
