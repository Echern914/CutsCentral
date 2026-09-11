import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * FINDING YOUR BARBER BY THE NAME ON THE DOOR.
 *
 * 🔴 WHAT WAS BROKEN. Shop creation turned "United Barbershop" into the handle
 * `united-barbershop`; the finder lowercased what was typed and validated it
 * against SLUG_REGEX, which rejects a space outright. So the one string
 * guaranteed to be correct - the shop's own name - was the one string that
 * could never resolve. Checked against production: every shop on the platform
 * 404'd when a customer typed its name, while its handle worked.
 *
 * 🔴 WHAT MUST NOT CHANGE. This is a LOOKUP, not a directory. Every letter is
 * still required, in order. The refusals below are as load-bearing as the
 * matches: they are the reason a customer cannot discover a shop nobody told
 * them about, and the reason a rival cannot list the neighbourhood.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

async function makeShop(name: string): Promise<string> {
  const email = `find-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "F", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name, bookingUrl: "https://f.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  return me.body.slug as string;
}

const find = (handle: string) =>
  request(app).get("/api/find-shop").query({ handle });

let unitedSlug: string;
let mikeySlug: string;

beforeAll(async () => {
  unitedSlug = await makeShop("United Barbershop");
  mikeySlug = await makeShop("FadesByMikey Barbershop");
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("the name on the door", () => {
  it("🔴 the shop's own name finds the shop", async () => {
    const res = await find("United Barbershop");
    expect(res.status).toBe(200);
    expect(res.body.shop.handle).toBe(unitedSlug);
  });

  it("finds it however the name is capitalised or spaced", async () => {
    for (const typed of [
      "united barbershop",
      "UNITED BARBERSHOP",
      "  United   Barbershop  ",
      "united-barbershop",
      "unitedbarbershop",
      "United_Barbershop",
    ]) {
      const res = await find(typed);
      expect(res.status, typed).toBe(200);
      expect(res.body.shop.handle, typed).toBe(unitedSlug);
    }
  });

  it("🔴 finds a shop whose own name puts the space somewhere odd", async () => {
    // "FadesByMikey Barbershop" mints `fadesbymikey-barbershop`: one word then
    // two. Nobody types that dash in the right place, and they should not have
    // to - this is the case the separator-insensitive second look exists for.
    expect(mikeySlug).toBe("fadesbymikey-barbershop");
    for (const typed of [
      "FadesByMikey Barbershop",
      "fades by mikey barbershop",
      "fadesbymikeybarbershop",
      "Fades-By-Mikey-Barbershop",
    ]) {
      const res = await find(typed);
      expect(res.status, typed).toBe(200);
      expect(res.body.shop.handle, typed).toBe(mikeySlug);
    }
  });

  it("still takes a pasted link or an @handle", async () => {
    for (const typed of [
      `https://getchairback.com/s/${unitedSlug}`,
      `getchairback.com/book/${unitedSlug}?utm=x`,
      `@${unitedSlug}`,
    ]) {
      const res = await find(typed);
      expect(res.status, typed).toBe(200);
      expect(res.body.shop.handle, typed).toBe(unitedSlug);
    }
  });
});

describe("🔴 it is still a lookup, not a directory", () => {
  it("refuses a PREFIX of a real handle", async () => {
    for (const typed of ["united", "united-barber", "fadesbymikey", "fades"]) {
      expect((await find(typed)).status, typed).toBe(404);
    }
  });

  it("refuses a word CONTAINED in a real name", async () => {
    for (const typed of ["barbershop", "mikey", "cuts"]) {
      expect((await find(typed)).status, typed).toBe(404);
    }
  });

  it("refuses a near miss - no fuzzy repair, no did-you-mean", async () => {
    for (const typed of [
      "united barbershopp",
      "untied barbershop",
      "united barbersho",
      "united barber shop x",
    ]) {
      expect((await find(typed)).status, typed).toBe(404);
    }
  });

  it("answers a miss identically however it misses", async () => {
    // Unparseable input, an unknown handle and a private shop must be one
    // answer, or the difference between them is a fact about a real business.
    const bodies = await Promise.all(
      ["", "!!!", "no-such-shop-anywhere", "a"].map(async (t) => {
        const res = await find(t);
        return { status: res.status, body: JSON.stringify(res.body) };
      }),
    );
    for (const b of bodies) {
      expect(b.status).toBe(404);
      expect(b.body).toBe(bodies[0]!.body);
    }
  });

  it("a shop with its public page OFF is not findable, by name or handle", async () => {
    const slug = await makeShop("Quiet Cuts Studio");
    expect((await find("Quiet Cuts Studio")).status).toBe(200);
    await prisma.shop.updateMany({ where: { slug }, data: { publicPageEnabled: false } });
    expect((await find("Quiet Cuts Studio")).status).toBe(404);
    expect((await find(slug)).status).toBe(404);
  });
});

describe("ambiguity is a miss, never a guess", () => {
  it("🔴 when two handles differ only by dashes, a loose spelling offers neither", async () => {
    // `cutco-studio` and `cutcostudio` share one separator-insensitive key.
    await prisma.shop.updateMany({
      where: { slug: unitedSlug },
      data: { slug: "cutco-studio" },
    });
    expect(await makeShop("Cutcostudio")).toBe("cutcostudio");

    // Each EXACT handle still resolves - the loose key is only consulted when
    // nothing matched exactly, so an unambiguous spelling is never penalised.
    expect((await find("cutco-studio")).status).toBe(200);
    expect((await find("cutcostudio")).status).toBe(200);

    // A spelling that matches NEITHER exactly, and both loosely, is refused
    // rather than guessed - handing over the wrong shop is worse than saying
    // nothing, because the customer would book it.
    expect((await find("cut-co-studio")).status).toBe(404);
    expect((await find("Cut Co Studio")).status).toBe(404);
  });
});
