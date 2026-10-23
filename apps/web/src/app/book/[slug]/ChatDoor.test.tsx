import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE BOOKING CHAT'S DOOR on the booking page: there exactly while the API
 * says the chat is on, and FAIL CLOSED otherwise - a 404 (switched off), an
 * error, or an API that predates the route all mean no link.
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

const { default: BookPage } = await import("./page");

function elements(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el, ...elements(el.props?.children)];
}

const SHOP = { ok: true, data: { shop: { name: "Fixture Cuts", slug: "fixture-cuts", customDomain: null }, staff: [], services: [] } };

async function doorFor(status: { ok: boolean; status?: number; data?: unknown }) {
  apiPublicGet.mockImplementation(async (path: string) => (path === "/api/assistant-chat/status" ? status : SHOP));
  const tree = await BookPage({ params: { slug: "fixture-cuts" }, searchParams: {} });
  return elements(tree).find((e) => (e.props as { "data-qa"?: string })?.["data-qa"] === "booking-chat-door");
}

afterEach(() => apiPublicGet.mockReset());

describe("the booking chat's door on the booking page", () => {
  it("on: one link to this shop's chat", async () => {
    const door = await doorFor({ ok: true, data: { enabled: true } });
    expect(door).toBeDefined();
    expect((door!.props as { href: string }).href).toBe("/book/fixture-cuts/assistant");
  });

  it.each([
    ["switched off (404)", { ok: false, status: 404, data: { error: "not_found" } }],
    ["the API errored", { ok: false, status: 500 }],
    ["an API that predates the route", { ok: false, status: 404 }],
    ["anything but enabled: true", { ok: true, data: { enabled: "yes" } }],
  ])("%s: no door", async (_why, status) => {
    expect(await doorFor(status)).toBeUndefined();
  });
});
