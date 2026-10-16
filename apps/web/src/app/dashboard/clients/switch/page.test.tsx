import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiGet }));
vi.mock("@/lib/vocab", () => ({
  getVocabulary: async () => NEUTRAL_VOCABULARY,
  capitalize: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("@/lib/contactUri", () => ({ copyText: vi.fn() }));

const { default: SwitchGuidePage } = await import("./page");

const SHOP = { name: "Demo Studio", slug: "demo-shop", publicPageEnabled: true, sectionOrder: [] as string[] };

async function show(shop: typeof SHOP | null) {
  apiGet.mockResolvedValue(shop ? { ok: true, data: shop } : { ok: false, data: null });
  render(await SwitchGuidePage());
}

/**
 * "Switching from Booksy or TheCut": what moves, how, and - for reviews -
 * an honest no plus a message the shop sends itself.
 */
describe("Switching from Booksy or TheCut guide", () => {
  beforeEach(() => apiGet.mockReset());

  it("gives the exact steps for each app and a button into each tool", async () => {
    await show(SHOP);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Export to CSV");
    expect(text).toContain("TheCut has no export");
    expect(text).toContain("All Contacts");
    expect(text).toContain("Export to file");
    expect(text).toMatch(/untick anyone who\s+isn't a client/);
    expect(screen.getByRole("link", { name: "Import your clients" }).getAttribute("href")).toBe(
      "/dashboard/clients?import=1",
    );
    expect(screen.getByRole("link", { name: "Open your hours" }).getAttribute("href")).toBe(
      "/dashboard/booking?tab=Staff",
    );
    // Services come across too: pasted from the old profile, checked, then added.
    expect(text).toContain("Paste your menu from another app");
    expect(screen.getByRole("link", { name: "Open your services" }).getAttribute("href")).toBe(
      "/dashboard/booking?tab=Services",
    );
  });

  it("is honest that reviews can't move, and hands over a message with the review link", async () => {
    await show(SHOP);
    const text = document.body.textContent ?? "";
    expect(text).toContain("don't let reviews be exported");
    expect(text).toContain("ChairBack doesn't send it for you");
    const message = (screen.getByRole("textbox", { name: "Your message" }) as HTMLTextAreaElement).value;
    expect(message).toContain("/s/demo-shop#reviews");
    // Appointments are not imported, and the page says what to do instead.
    expect(text).toContain("Booksy support can email it to you");
  });

  it("warns when the page hides its reviews section", async () => {
    await show({ ...SHOP, sectionOrder: ["promotions", "hours"] });
    expect(document.body.textContent).toContain("Reviews are switched off on your page right now");
  });

  it("offers no review link while the page isn't live", async () => {
    await show({ ...SHOP, publicPageEnabled: false });
    expect(document.body.textContent).toContain("Your page isn't live yet");
    expect(screen.queryByRole("textbox", { name: "Your message" })).toBeNull();
  });
});
