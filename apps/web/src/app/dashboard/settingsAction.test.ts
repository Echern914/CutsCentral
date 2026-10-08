import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 A REFUSED SETTINGS SAVE NAMES THE BOX. The PATCH is refused whole for one
 * bad field, and every refusal read "Could not save settings." - with the
 * name, link and texts toggle edited in the same save lost too.
 */

const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend, apiGet: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined, getAll: () => [] }), headers: () => new Map() }));

const { saveSettingsAction } = await import("./actions");

function form(over: Record<string, string> = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ name: "Dee's", nudgeBufferDays: "7", dailySendCap: "50", rebookWindowDays: "14", ...over })) {
    f.set(k, v);
  }
  return f;
}

beforeEach(() => apiSend.mockReset());

describe("saveSettingsAction", () => {
  it("names the field the API refused", async () => {
    apiSend.mockResolvedValue({ ok: false, status: 400, error: "invalid_input", issues: [{ path: ["dailySendCap"], message: "too big" }] });
    const out = await saveSettingsAction({}, form({ dailySendCap: "5000" }));
    expect(out.error).toBe("Daily SMS cap must be a whole number from 1 to 1,000.");
  });

  it("a save that goes through says so", async () => {
    apiSend.mockResolvedValue({ ok: true, status: 200, data: {} });
    expect(await saveSettingsAction({}, form())).toEqual({ saved: true });
  });
});
