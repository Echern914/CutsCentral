import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { BookShopData } from "./[slug]/page";
import type { GroupView } from "./group/[token]/actions";

vi.mock("./[slug]/group/actions", () => ({
  groupSlotsAction: vi.fn(),
  groupPlanAction: vi.fn(),
  groupCreateAction: vi.fn(),
}));
vi.mock("./group/[token]/actions", () => ({
  groupViewAction: vi.fn(),
  groupRescheduleAction: vi.fn(),
  cancelMemberAction: vi.fn(),
  cancelGroupAction: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ apiPublicGet: vi.fn() }));

const { GroupBookingClient } = await import("./[slug]/group/GroupBookingClient");
const { GroupManageClient } = await import("./group/[token]/GroupManageClient");
const { default: GroupBookPage } = await import("./[slug]/group/page");
const api = await import("@/lib/api");
const apiGet = vi.mocked(api.apiPublicGet);

/**
 * 🔴 THE APP OPENS EVERY /book/* LINK IN A WEBVIEW THAT WAITS FOR "cb:ready".
 *
 * The web's apple-app-site-association hands /book/* to the app, and the app's
 * WebView (apps/mobile/src/AppWebView.tsx, `awaitsReady`) keeps its spinner up
 * until the page posts cb:ready - it does not trust onLoadEnd. The two group
 * pages never posted it, so a party link spun for 20 seconds and then said
 * "Couldn't load". Every answer these routes can give must post it, including
 * the server-only ones that have no client component of their own.
 */
const TZ = "America/New_York";

const shop = {
  name: "Chern Cuts",
  slug: "cherncuts",
  timezone: TZ,
  logoUrl: null,
  accentColor: null,
  instagramHandle: null,
  bookingLeadHours: 2,
  bookingMaxDays: 60,
  payDirect: null,
} as unknown as BookShopData["shop"];

const data = {
  shop,
  staff: [{ id: "stf_1", name: "Sam", bio: null, imageUrl: null }],
  services: [{ id: "svc_cut", name: "Haircut", durationMin: 30 }],
  offerings: [{ serviceId: "svc_cut", staffId: "stf_1" }],
  groups: [],
  openWeekdays: [0, 1, 2, 3, 4, 5, 6],
  targetedSlots: [],
  addOns: [],
} as unknown as BookShopData;

const GROUP: GroupView = {
  status: "ACTIVE",
  bookedBy: "Eric",
  shop: { slug: "cherncuts", name: "Chern Cuts", timezone: TZ },
  staff: { id: "stf_1", name: "Sam" },
  startsAt: "2026-03-14T18:00:00.000Z",
  endsAt: "2026-03-14T18:30:00.000Z",
  members: [
    {
      appointmentId: "a1",
      manageToken: "mt_1",
      position: 0,
      firstName: "Eric",
      status: "BOOKED",
      serviceId: "svc_cut",
      serviceName: "Haircut",
      startsAt: "2026-03-14T18:00:00.000Z",
      endsAt: "2026-03-14T18:30:00.000Z",
      priceCents: 4000,
    },
  ],
} as GroupView;

let posted: string[];

beforeEach(() => {
  posted = [];
  (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = {
    postMessage: (m: string) => posted.push(m),
  };
  apiGet.mockReset();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("group pages tell the app they are ready", () => {
  it("booking a party (/book/<slug>/group)", () => {
    render(<GroupBookingClient data={data} />);
    expect(posted).toContain("cb:ready");
  });

  it("managing a party (/book/group/<token>)", () => {
    render(<GroupManageClient token="grp_tok_test" initial={GROUP} />);
    expect(posted).toContain("cb:ready");
  });

  it("a shop that takes money at booking: the server-only answer", async () => {
    apiGet.mockResolvedValue({
      ok: true,
      data: { ...data, shop: { ...shop, payment: { collects: true } } },
    } as never);
    render(await GroupBookPage({ params: { slug: "cherncuts" } }));
    expect(posted).toContain("cb:ready");
  });

  it("a shop whose booking is paused: the server-only answer", async () => {
    apiGet.mockResolvedValue({
      ok: true,
      data: { ...data, shop: { ...shop, bookingPaused: true } },
    } as never);
    render(await GroupBookPage({ params: { slug: "cherncuts" } }));
    expect(posted).toContain("cb:ready");
  });

  it("is harmless in a browser, where there is no app to tell", () => {
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
    expect(() => render(<GroupManageClient token="grp_tok_test" initial={GROUP} />)).not.toThrow();
  });
});
