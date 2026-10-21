import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE LINK THE EDITOR TEST CANNOT SEE.
 *
 * `PageEditor.test.tsx` mocks `./actions`, so it proves the editor HANDS the
 * privacy flag to the save - and nothing about whether the flag reaches the
 * API. The action rebuilds the PATCH body from a whitelist (extra keys are
 * dropped on purpose), so a field missing from that list saves as a silent
 * no-op: the switch would flip, "Your page is saved" would show, and the
 * street would stay on Google.
 */
const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend, apiGet: vi.fn() }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const { savePageAction } = await import("./actions");

beforeEach(() => {
  apiSend.mockReset();
  revalidatePath.mockReset();
  apiSend.mockResolvedValue({ ok: true, data: {} });
});

describe("savePageAction", () => {
  it("🔴 forwards the address privacy flag, both ways", async () => {
    expect(await savePageAction({ addressPrivate: true })).toEqual({ ok: true });
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { addressPrivate: true });

    await savePageAction({ addressPrivate: false });
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { addressPrivate: false });
  });

  it("still drops keys that are not page fields", async () => {
    await savePageAction({ addressPrivate: true, bogus: 1 } as never);
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { addressPrivate: true });
  });
});

describe("savePageAction and the shop name", () => {
  it("🔴 a rename PATCHes the name alone - never the slug", async () => {
    apiSend.mockResolvedValue({ ok: true, data: { slug: "home-studio" } });
    expect(await savePageAction({ name: "Fades by Mikey" })).toEqual({ ok: true });
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { name: "Fades by Mikey" });
  });

  it("🔴 refreshes the dashboard header and both public pages", async () => {
    apiSend.mockResolvedValue({ ok: true, data: { slug: "home-studio" } });
    await savePageAction({ name: "Fades by Mikey" });
    const paths = revalidatePath.mock.calls.map((c) => c.join(" "));
    expect(paths).toEqual(
      expect.arrayContaining(["/dashboard layout", "/s/home-studio", "/book/home-studio"]),
    );
  });

  it("words the API's min/max refusal the way the Settings card does", async () => {
    apiSend.mockResolvedValue({
      ok: false,
      error: "invalid_input",
      issues: [{ path: ["name"], code: "too_big", message: "String must contain at most 120 character(s)" }],
    });
    expect(await savePageAction({ name: "x".repeat(121) })).toEqual({
      ok: false,
      fieldErrors: { name: "Keep the shop name under 120 characters." },
    });
    apiSend.mockResolvedValue({
      ok: false,
      error: "invalid_input",
      issues: [{ path: ["name"], code: "too_small", message: "String must contain at least 1 character(s)" }],
    });
    expect(await savePageAction({ name: "" })).toEqual({
      ok: false,
      fieldErrors: { name: "Your shop needs a name." },
    });
  });
});
