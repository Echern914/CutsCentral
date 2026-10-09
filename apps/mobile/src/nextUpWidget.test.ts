import { describe, expect, it, vi } from "vitest";
import { clearNextUpWidget, createWidgetRefresher, refreshNextUpWidget, WIDGET_KEYS, type WidgetStore } from "./nextUpWidget";

function memoryStore() {
  const data = new Map<string, string>();
  const reload = vi.fn();
  const store: WidgetStore = {
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
    reload,
  };
  return { data, store, reload };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SNAPSHOT = {
  shop: { name: "Next Up Cuts", timezone: "America/New_York" },
  showNames: true,
  generatedAt: "2026-10-08T18:00:00.000Z",
  appointments: [{ id: "a1", startsAt: "2026-10-08T18:30:00.000Z", endsAt: "2026-10-08T19:00:00.000Z", client: "Sam", service: "Fade", chair: "Dev" }],
};

function fetchReturning(token: Response, list: Response) {
  return vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith("/token") ? token : list));
}

const base = { bearer: "session", apiOrigin: "https://api.example.com", webOrigin: "https://example.com" };

describe("feeding the Lock Screen widget", () => {
  it("🔴 hands the widget a snapshot AND its own token - never the session", async () => {
    const { data, store, reload } = memoryStore();
    const fetch = fetchReturning(json(200, { token: "wgt.abc" }), json(200, SNAPSHOT));
    expect(await refreshNextUpWidget({ ...base, fetch, store })).toBe("refreshed");
    expect(data.get(WIDGET_KEYS.token)).toBe("wgt.abc");
    expect(JSON.parse(data.get(WIDGET_KEYS.snapshot)!)).toEqual(SNAPSHOT);
    expect(data.get(WIDGET_KEYS.apiOrigin)).toBe(base.apiOrigin);
    expect(data.get(WIDGET_KEYS.webOrigin)).toBe(base.webOrigin);
    expect([...data.values()]).not.toContain("session");
    expect(reload).toHaveBeenCalledTimes(1);
    // The session is only ever a header on the app's own two requests.
    for (const call of fetch.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({ Authorization: "Bearer session" });
    }
  });

  it("🔴 a dead session clears the widget - a locked phone shows nothing of the shop", async () => {
    const { data, store } = memoryStore();
    data.set(WIDGET_KEYS.snapshot, JSON.stringify(SNAPSHOT));
    data.set(WIDGET_KEYS.token, "wgt.old");
    const fetch = fetchReturning(json(401, { error: "unauthorized" }), json(401, { error: "unauthorized" }));
    expect(await refreshNextUpWidget({ ...base, fetch, store })).toBe("signed_out");
    expect(data.size).toBe(0);
  });

  it("offline or a server error keeps what the widget already has", async () => {
    const { data, store } = memoryStore();
    data.set(WIDGET_KEYS.snapshot, "kept");
    const offline = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    expect(await refreshNextUpWidget({ ...base, fetch: offline, store })).toBe("failed");
    const broken = fetchReturning(json(200, { token: "wgt.x" }), json(503, {}));
    expect(await refreshNextUpWidget({ ...base, fetch: broken, store })).toBe("failed");
    expect(data.get(WIDGET_KEYS.snapshot)).toBe("kept");
  });

  it("sign-out clears every key and rebuilds the widget", () => {
    const { data, store, reload } = memoryStore();
    for (const k of Object.values(WIDGET_KEYS)) data.set(k, "x");
    clearNextUpWidget(store);
    expect(data.size).toBe(0);
    expect(reload).toHaveBeenCalled();
  });
});

describe("refreshing at most so often", () => {
  it("joins a refresh in flight, skips one inside the interval, and a forced one always runs", async () => {
    let t = 0;
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<"refreshed">((r) => {
          release = () => r("refreshed");
        }),
    );
    const r = createWidgetRefresher(run, 60_000, () => t);
    const first = r.refresh();
    expect(r.refresh()).toBe(first); // joined
    release();
    await first;
    t = 30_000;
    expect(r.refresh()).toBeNull(); // too soon
    const forced = r.refresh(true);
    expect(forced).not.toBeNull();
    release();
    await forced;
    expect(run).toHaveBeenCalledTimes(2);
  });
});
