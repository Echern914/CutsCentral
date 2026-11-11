import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * A shop's links while it has hidden its page.
 *
 * A paying shop's every client link said "That page doesn't exist": its page
 * had been switched to Hidden, which stops online booking too, and the plain
 * not-found said nothing about why. The links were right. They now name the
 * shop and say it isn't taking online bookings right now. A link to no shop,
 * and any visit through a custom domain, stay the plain not-found.
 */
const apiPublicGet = vi.fn();
vi.mock("@/lib/api", () => ({ apiPublicGet: (...a: unknown[]) => apiPublicGet(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import BookPage from "./page";
import ShopPage from "@/app/s/[slug]/page";
import { hiddenShopFrom } from "@/app/s/[slug]/shopPage";
import { hiddenShopHeading } from "@/app/s/[slug]/HiddenShopNotice";

const refused = { ok: false, status: 404, data: null, error: "not_found", body: { error: "not_found" } };
const hidden = (booksHere: boolean) => ({
  ok: false,
  status: 404,
  data: null,
  error: "page_hidden",
  body: { error: "page_hidden", name: "Fade Room", booksHere },
});

function answer(pageRes: unknown) {
  apiPublicGet.mockImplementation(async (path: string) =>
    path.startsWith("/api/book/") ? refused : pageRes,
  );
}

const book = (searchParams: Record<string, string> = {}) =>
  BookPage({ params: { slug: "fade-room" }, searchParams });
const shop = (searchParams: Record<string, string> = {}) =>
  ShopPage({ params: { slug: "fade-room" }, searchParams });

afterEach(() => apiPublicGet.mockReset());

describe("/book/<slug> for a shop whose page is hidden", () => {
  it("names the shop and says it isn't taking online bookings, instead of a 404", async () => {
    answer(hidden(true));
    render((await book()) as ReactElement);
    expect(
      screen.getByRole("heading", { name: "Fade Room isn't taking online bookings right now" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your link is the right one/)).toBeInTheDocument();
    expect(screen.getByText(/An appointment you already have still stands/)).toBeInTheDocument();
    expect(screen.queryByText(/doesn.t exist/)).toBeNull();
  });

  it("for a shop that books elsewhere, says the page isn't available - never 'not taking bookings'", async () => {
    answer(hidden(false));
    render((await book()) as ReactElement);
    expect(screen.getByRole("heading", { name: "Fade Room's page isn't available right now" })).toBeInTheDocument();
    expect(screen.queryByText(/online bookings/)).toBeNull();
    expect(screen.queryByText(/still stands/)).toBeNull();
  });

  it("is still a plain 404 for a link to no shop at all", async () => {
    answer(refused);
    await expect(book()).rejects.toThrow("NOT_FOUND");
  });

  it("🔴 through a custom domain, names nobody: still the plain 404", async () => {
    answer(hidden(true));
    await expect(book({ cb_domain: "faderoom.com" })).rejects.toThrow("NOT_FOUND");
  });

  it("a failed read that is not 'hidden' (a timeout) is never shown as a hidden shop", async () => {
    answer({ ok: false, status: 0, data: null, error: "network_error" });
    await expect(book()).rejects.toThrow("NOT_FOUND");
  });
});

describe("/s/<slug> for a shop whose page is hidden", () => {
  it("names the shop instead of a 404", async () => {
    answer(hidden(true));
    render((await shop()) as ReactElement);
    expect(
      screen.getByRole("heading", { name: "Fade Room isn't taking online bookings right now" }),
    ).toBeInTheDocument();
  });

  it("is still a plain 404 for a link to no shop, and through a custom domain", async () => {
    answer(refused);
    await expect(shop()).rejects.toThrow("NOT_FOUND");
    answer(hidden(true));
    await expect(shop({ cb_domain: "faderoom.com" })).rejects.toThrow("NOT_FOUND");
  });
});

describe("reading 'hidden' from the page API", () => {
  it("only from a 404 that says page_hidden with a name", () => {
    expect(hiddenShopFrom(hidden(true))).toEqual({ name: "Fade Room", booksHere: true });
    expect(hiddenShopFrom(refused)).toBeNull();
    expect(hiddenShopFrom({ ok: false, status: 500, body: { error: "page_hidden", name: "X" } })).toBeNull();
    expect(hiddenShopFrom({ ok: false, status: 404, body: { error: "page_hidden", name: "  " } })).toBeNull();
    expect(hiddenShopFrom({ ok: false, status: 404 })).toBeNull();
    // Anything but a literal true is a shop that books elsewhere.
    expect(hiddenShopFrom({ ok: false, status: 404, body: { error: "page_hidden", name: "X", booksHere: "yes" } }))
      .toEqual({ name: "X", booksHere: false });
  });

  it("headings", () => {
    expect(hiddenShopHeading({ name: "Sharp Lines", booksHere: true })).toBe(
      "Sharp Lines isn't taking online bookings right now",
    );
    expect(hiddenShopHeading({ name: "Sharp Lines", booksHere: false })).toBe(
      "Sharp Lines's page isn't available right now",
    );
  });
});
