import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ShopPageData } from "@/app/s/[slug]/page";
import type { ShopPageSettings } from "./page";

const save = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ ok: true })));
// The live preview is the public page component; what matters here is the
// DATA it is handed, so the mock keeps the last payload and renders nothing.
const preview = vi.hoisted(() => ({ last: null as ShopPageData | null }));
vi.mock("./actions", () => ({ savePageAction: save }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./LivePreview", () => ({
  LivePreview: ({ data }: { data: ShopPageData }) => {
    preview.last = data;
    return null;
  },
}));

const { PageEditor } = await import("./PageEditor");

/**
 * "Gotta figure out how to add my address but not have it on Google."
 *
 * The switch sits with the address fields, says who still gets the street,
 * and saves as one field - the editor diff-saves, so turning privacy on must
 * not re-send (or clobber) the address itself.
 */

function settings(over: Partial<ShopPageSettings> = {}): ShopPageSettings {
  return {
    name: "Home Studio",
    slug: "home-studio",
    industry: "barber",
    serviceNoun: null,
    publicPageEnabled: true,
    theme: "classic",
    bio: null,
    logoUrl: null,
    accentColor: null,
    heroImageUrl: null,
    instagramHandle: null,
    googleReviewUrl: null,
    hoursText: null,
    addressStreet: "123 Main St",
    addressCity: "Wilmington",
    addressRegion: "DE",
    addressPostal: "19801",
    addressPrivate: false,
    gallery: [],
    fontKey: null,
    layoutStyle: null,
    sectionOrder: [],
    rewardsWelcome: null,
    rewardsSections: [],
    takesRequests: false,
    waitlistEnabled: false,
    notifyPhone: null,
    bookingUrl: null,
    bookingMode: "native",
    punchesPerVisit: 1,
    ...over,
  };
}

const privacySwitch = () =>
  screen.getByRole("switch", { name: "Keep my street address private" });

beforeEach(() => {
  save.mockClear();
  preview.last = null;
});

describe("keeping the street address private", () => {
  it("is off for a public address, and says who still gets the street", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    expect(privacySwitch()).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText(/Clients still get the full address in their booking confirmation/),
    ).toBeInTheDocument();
    // The old label promised Google the whole address, unconditionally.
    expect(screen.queryByText(/helps you show up on Google\)/)).toBeNull();
    expect(preview.last?.addressStreet).toBe("123 Main St");
  });

  it("🔴 on: saves the flag alone, and the preview loses the street and ZIP", async () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    fireEvent.click(privacySwitch());
    expect(privacySwitch()).toHaveAttribute("aria-checked", "true");
    expect(preview.last).toMatchObject({
      addressStreet: null,
      addressCity: "Wilmington",
      addressRegion: "DE",
      addressPostal: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Diff-save: exactly the one field that changed - the stored address is
    // untouched, which is what makes this visibility and not deletion.
    expect(save.mock.calls[0]![0]).toEqual({ addressPrivate: true });
  });

  it("reads a saved private address back as on", () => {
    render(<PageEditor settings={settings({ addressPrivate: true })} appBase="https://app.test" />);
    expect(privacySwitch()).toHaveAttribute("aria-checked", "true");
    // The owner still sees - and can edit - the street being kept private.
    expect(screen.getByDisplayValue("123 Main St")).toBeInTheDocument();
    expect(preview.last?.addressStreet).toBeNull();
  });

  it("an API that predates the flag reads as off, with nothing to save", () => {
    render(
      <PageEditor settings={settings({ addressPrivate: undefined })} appBase="https://app.test" />,
    );
    expect(privacySwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
  });
});
