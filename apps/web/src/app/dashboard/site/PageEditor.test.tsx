import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/**
 * "Have them as templates... keep the one that everyone has been using now as
 * the default." The picker starts on Classic for a shop that never chose, a
 * pick previews at once and saves as its one field, and a photo can say what
 * it shows and who did it.
 */
describe("the page design", () => {
  const designs = () => within(screen.getByRole("group", { name: "Page design" }));

  it("🔴 a shop that never picked one is on Classic, with nothing to save", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    expect(designs().getByRole("button", { name: /^Classic/ })).toHaveAttribute("aria-pressed", "true");
    expect(preview.last?.pageDesign).toBe("classic");
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
  });

  it("picking one previews it at once and saves that field alone", async () => {
    render(<PageEditor settings={settings({ pageDesign: "classic" })} appBase="https://app.test" />);
    fireEvent.click(designs().getByRole("button", { name: /^Photos first/ }));
    expect(designs().getByRole("button", { name: /^Photos first/ })).toHaveAttribute("aria-pressed", "true");
    expect(preview.last?.pageDesign).toBe("grid");
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ pageDesign: "grid" });
  });

  it("🔴 a photo's tags save with it; the preview keeps only tags a client could book", async () => {
    const menu = {
      services: [
        { id: "svc-cut", name: "Haircut", description: null, imageUrl: null, durationMin: 30, price: 35, active: true, visibility: "public" },
        { id: "svc-private", name: "Private", description: null, imageUrl: null, durationMin: 60, price: 90, active: true, visibility: "hidden" },
      ],
      staff: [
        { id: "st-a", name: "Marcus", imageUrl: null, active: true },
        { id: "st-b", name: "Dre", imageUrl: null, active: true },
      ],
    };
    render(
      <PageEditor
        settings={settings({ gallery: [{ url: "https://img.test/1.jpg", addedAt: "2026-09-01T00:00:00.000Z" }] })}
        menu={menu}
        appBase="https://app.test"
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Service in photo 1" }), { target: { value: "svc-cut" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Who did photo 1" }), { target: { value: "st-b" } });
    expect(preview.last?.gallery[0]).toMatchObject({ serviceId: "svc-cut", staffId: "st-b" });
    expect(preview.last?.services?.map((s) => s.id)).toEqual(["svc-cut"]);

    // A hidden service can be tagged - it's still the shop's - but the page
    // won't offer to book it, and the preview shows exactly that.
    expect(screen.getByRole("option", { name: "Private (hidden)" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Service in photo 1" }), { target: { value: "svc-private" } });
    expect(preview.last?.gallery[0]?.serviceId).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The date is the server's to keep; the editor never sends one.
    expect(save.mock.calls[0]![0]).toEqual({
      gallery: [{ url: "https://img.test/1.jpg", serviceId: "svc-private", staffId: "st-b" }],
    });
  });
});

/**
 * "We need a place where you can also switch your shop's name that is shown
 * on the page." The name sat only in the Overview's Settings card; it now
 * leads the page editor, previews as you type, and saves as its one field -
 * never the slug, so links already in Instagram bios keep working.
 */
describe("the shop name", () => {
  const nameField = () => screen.getByRole("textbox", { name: "Shop name" });
  const saveButton = () => screen.getByRole("button", { name: "Save page" });

  it("shows the current name and the link that will not change", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    expect(nameField()).toHaveValue("Home Studio");
    // The hint is the field's description, and names the real link.
    const hint = document.getElementById(nameField().getAttribute("aria-describedby")!)!;
    expect(hint).toHaveTextContent(
      "Shown at the top of your booking page and shop page. Your link (https://app.test/s/home-studio) stays the same.",
    );
  });

  it("🔴 the preview takes the typed name at once", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    expect(preview.last?.name).toBe("Home Studio");
    fireEvent.change(nameField(), { target: { value: "Fades by Mikey" } });
    expect(preview.last?.name).toBe("Fades by Mikey");
    // The link in the preview is the saved one - a rename does not move it.
    expect(preview.last?.slug).toBe("home-studio");
  });

  it("🔴 saves the name alone, trimmed - no slug, nothing else", async () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    fireEvent.change(nameField(), { target: { value: "  Fades by Mikey  " } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ name: "Fades by Mikey" });
  });

  it("refuses an empty name before it saves", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    fireEvent.change(nameField(), { target: { value: "   " } });
    expect(screen.getByRole("alert")).toHaveTextContent("Your shop needs a name.");
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
  });

  it("refuses a name over 120 characters before it saves", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    fireEvent.change(nameField(), { target: { value: "x".repeat(121) } });
    expect(screen.getByRole("alert")).toHaveTextContent("Keep the shop name under 120 characters.");
    expect(saveButton()).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: "x".repeat(120) } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton()).toBeEnabled();
  });

  it("shows the API's refusal under the field", async () => {
    save.mockResolvedValueOnce({ ok: false, fieldErrors: { name: "Your shop needs a name." } } as never);
    render(<PageEditor settings={settings()} appBase="https://app.test" />);
    fireEvent.change(nameField(), { target: { value: "New Name" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("Your shop needs a name.")).toBeInTheDocument());
    // Inline, not repeated as "name: ..." in the save bar.
    expect(screen.queryByText(/^name:/)).toBeNull();
  });

  it("🔴 a seat that can't rename sees the name read-only, with who to ask", () => {
    render(<PageEditor settings={settings()} appBase="https://app.test" canEditName={false} />);
    expect(screen.queryByRole("textbox", { name: "Shop name" })).toBeNull();
    expect(screen.getByText("Home Studio")).toBeInTheDocument();
    expect(screen.getByText("Ask the shop owner to change it.")).toBeInTheDocument();
  });
});
