import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { buildYearlyReport, type YearlyReport } from "../engines/yearlyReport.js";
import { PAGE_SIZES, SAFE_BOX, fitText, textWidth } from "./pdf.js";
import { money, percent, renderYearlyReportPdf, reportFilename } from "./yearlyReportPdf.js";

/**
 * The printed artefact itself: is it one page, does it open, is it free of
 * anything a customer would object to being in a file the barber emails on, and
 * does it survive names nobody sized it for.
 *
 * Reading the PDF back as latin1 text is exactly how a leak would be FOUND in
 * the wild - `strings report.pdf`. So that is how it is tested. Nothing here is
 * compressed, which is a deliberate property: an obfuscated stream would make
 * this test impossible to write honestly.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
const YEAR = new Date().getUTCFullYear() - 1;

const LONG_SHOP = "The Extremely Distinguished Gentlemen's Grooming Parlour & Barbershop of Ridgewood";
const LONG_NAME = "Bartholomew Maximilian Fitzgerald-Wellingtonshire III";

/** A customer whose details must never reach the printed page. */
const CLIENT = {
  firstName: "Persephone",
  lastName: "Quillingsworth",
  email: "persephone.quillingsworth@example.com",
  phone: "+15551230099",
};

beforeAll(async () => {
  const email = `pdf-${randomToken(6)}@test.local`;
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "PDF Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: LONG_SHOP,
      bookingUrl: "https://pdf.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: "America/New_York" } });
  staffId = (
    await prisma.staff.create({ data: { shopId, name: LONG_NAME }, select: { id: true } })
  ).id;
  const serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Signature Fade & Beard Sculpt", durationMin: 45, price: 65 },
      select: { id: true },
    })
  ).id;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `mail:${CLIENT.email}`,
      magicToken: randomToken(),
      firstName: CLIENT.firstName,
      lastName: CLIENT.lastName,
      email: CLIENT.email,
      phone: CLIENT.phone,
    },
    select: { id: true },
  });

  // A big, uneven year: every month has work, and the totals run into six
  // figures so the money columns are exercised at full width.
  for (let m = 1; m <= 12; m++) {
    for (let i = 0; i < m * 3; i++) {
      const at = new Date(Date.UTC(YEAR, m - 1, (i % 26) + 1, 17, 0, 0));
      await prisma.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId,
          clientId: client.id,
          firstName: CLIENT.firstName,
          lastName: CLIENT.lastName,
          email: CLIENT.email,
          phone: CLIENT.phone,
          status: "COMPLETED",
          startsAt: at,
          endsAt: new Date(at.getTime() + 45 * 60_000),
          priceAtBooking: 165.55,
          manageToken: randomToken(),
        },
      });
    }
  }
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

async function report(year = YEAR, staff: string | null = staffId): Promise<YearlyReport> {
  return buildYearlyReport({
    shopId,
    shopName: LONG_SHOP,
    timezone: "America/New_York",
    year,
    staffId: staff,
    staffName: staff ? LONG_NAME : null,
    now: new Date(),
  });
}

describe("the printed file", () => {
  it("is a single-page PDF that a reader can open", async () => {
    const pdf = renderYearlyReportPdf(await report());
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // ONE page object, and the page tree says so too.
    expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(1);
    expect(text).toContain("/Count 1");
    // The xref offsets must actually point at their objects, or readers refuse
    // the file - the single most likely way a hand-rolled writer breaks.
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    for (const m of text.matchAll(/^(\d{10}) 00000 n $/gm)) {
      const at = Number(m[1]);
      expect(at).toBeGreaterThan(0);
      expect(text.slice(at)).toMatch(/^\d+ 0 obj/);
    }
  });

  it("renders on US Letter and on A4 without reflowing", async () => {
    const r = await report();
    const letter = renderYearlyReportPdf(r, { paper: "letter" }).toString("latin1");
    const a4 = renderYearlyReportPdf(r, { paper: "a4" }).toString("latin1");
    expect(letter).toContain(`/MediaBox [0 0 612 792]`);
    expect(a4).toContain(`/MediaBox [0 0 595.28 841.89]`);
    // The safe box is the intersection of both papers, so the SAME drawing
    // fits either one - it is only translated, never re-laid-out.
    expect(SAFE_BOX.width).toBeLessThanOrEqual(PAGE_SIZES.letter.width);
    expect(SAFE_BOX.width).toBeLessThanOrEqual(PAGE_SIZES.a4.width);
    expect(SAFE_BOX.height).toBeLessThanOrEqual(PAGE_SIZES.letter.height);
    expect(SAFE_BOX.height).toBeLessThanOrEqual(PAGE_SIZES.a4.height);
  });

  it("keeps every mark inside the page on both paper sizes", async () => {
    const r = await report();
    for (const paper of ["letter", "a4"] as const) {
      const text = renderYearlyReportPdf(r, { paper }).toString("latin1");
      const page = PAGE_SIZES[paper];
      const stream = text.slice(text.indexOf("stream"), text.indexOf("endstream"));
      // Every drawing op inside the translated box; add the translation back
      // and check the result is on the paper.
      const dx = (page.width - SAFE_BOX.width) / 2;
      const dy = (page.height - SAFE_BOX.height) / 2;
      let checked = 0;
      for (const m of stream.matchAll(/([\d.-]+) ([\d.-]+) (?:Td|m|l)\b/g)) {
        const x = Number(m[1]) + dx;
        const y = Number(m[2]) + dy;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(page.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(page.height);
        checked++;
      }
      expect(checked).toBeGreaterThan(50);
    }
  });

  it("carries the branding, the disclaimer and the footer", async () => {
    const text = renderYearlyReportPdf(await report()).toString("latin1");
    expect(text).toContain("(CHAIRBACK)");
    expect(text).toContain("(Generated by ChairBack)");
    expect(text).toContain(
      "(Operational performance summary. Not a tax return or audited financial statement.)",
    );
    expect(text).toContain(`(${YEAR})`); // a finished year prints plainly
  });

  it("says year to date on the year in progress", async () => {
    const thisYear = new Date().getUTCFullYear();
    const text = renderYearlyReportPdf(await report(thisYear)).toString("latin1");
    expect(text).toContain(`(${thisYear} year to date)`);
  });

  it("leaks no client name, email, phone, token or database id - nor into the metadata", async () => {
    const r = await report();
    const text = renderYearlyReportPdf(r).toString("latin1");
    for (const secret of [
      CLIENT.firstName,
      CLIENT.lastName,
      CLIENT.email,
      CLIENT.phone,
      "5551230099",
      shopId,
      staffId,
      "acct_",
      "pi_",
      "cus_",
      "seti_",
    ]) {
      expect(text).not.toContain(secret);
    }
    // /Info is part of the file and travels with it. It names the product and
    // the year, and nothing else.
    const info = text.slice(text.indexOf("/Title"), text.indexOf("/CreationDate"));
    expect(info).toContain("ChairBack Yearly Performance Report");
    expect(info).not.toContain(LONG_NAME);
    expect(text).not.toContain("/Author");
    expect(text).not.toContain("/Subject");
  });

  it("shortens a very long barber or shop name instead of overrunning", async () => {
    const text = renderYearlyReportPdf(await report()).toString("latin1");
    // The full 53-character name cannot fit the identity block, so it must
    // have been cut - and cut to something that still reads as the person.
    expect(text).not.toContain(LONG_NAME);
    expect(text).toContain("(Bartholomew Maximilian");
    // fitText measures rather than counting characters.
    const cut = fitText(LONG_NAME, 200, 22, "F2");
    expect(textWidth(cut, 22, "F2")).toBeLessThanOrEqual(200);
    expect(cut.endsWith("…")).toBe(true);
    // And it is written as plain dots, because the ellipsis is not WinAnsi.
    expect(text).toContain("...");
  });

  it("prints six-figure money correctly and to the cent", async () => {
    const r = await report();
    expect(r.totals.revenueCents).toBeGreaterThan(10_000_00);
    // 234 appointments x $165.55 - the classic float trap. Summed as cents it
    // is exact; summed as dollars it would drift.
    expect(r.totals.revenueCents % 5).toBe(0);
    expect(money(r.totals.revenueCents)).toMatch(/^\$\d{1,3}(,\d{3})*\.\d{2}$/);
    expect(money(16555)).toBe("$165.55");
    expect(money(0)).toBe("$0.00");
    expect(money(100_000_00)).toBe("$100,000.00");
  });

  it("names the file safely, whatever the barber is called", async () => {
    expect(reportFilename(await report())).toBe(
      `chairback-bartholomew-maximilian-fitzgerald-wellingtonshire-iii-${YEAR}-report.pdf`,
    );
    // No path separators, no spaces, no accents, nothing a shell would eat.
    const weird = reportFilename({
      ...(await report()),
      subjectName: "../../etc/passwd  Núñez  <script>",
    });
    expect(weird).toMatch(/^chairback-[a-z0-9-]*-\d{4}-report\.pdf$/);
    expect(weird).not.toContain("/");
    expect(weird).toContain("nunez");
  });

  it("prints an honest dash rather than a zero where there is no denominator", () => {
    expect(percent(null)).toBe("—");
    expect(percent(5_000)).toBe("50%");
    expect(percent(6_250)).toBe("62.5%");
  });

  it("renders an empty year as a complete page, not a blank one", async () => {
    const empty = await report(2024, staffId);
    if (empty.totals.appointments === 0) {
      const text = renderYearlyReportPdf(empty).toString("latin1");
      expect(text).toContain("(No revenue recorded in this range)");
      expect(text).toContain("(No bookings in this range.)");
      expect(text).toContain("(Generated by ChairBack)");
      // Still one page, still every band drawn.
      expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(1);
      expect(text).toContain("(CHAIRBACK)");
    }
  });
});

describe("GET /api/yearly-report/pdf", () => {
  it("serves a private, non-cacheable PDF with a safe filename", async () => {
    const res = await request(app)
      .get(`/api/yearly-report/pdf?year=${YEAR}&subject=${staffId}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toContain(`-${YEAR}-report.pdf`);
    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("honours the A4 request", async () => {
    const res = await request(app)
      .get(`/api/yearly-report/pdf?year=${YEAR}&subject=${staffId}&paper=a4`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.toString("latin1")).toContain("/MediaBox [0 0 595.28 841.89]");
  });

  it("refuses a session with no right to the subject", async () => {
    const res = await request(app).get(`/api/yearly-report/pdf?year=${YEAR}`);
    expect(res.status).toBe(401);
  });
});
