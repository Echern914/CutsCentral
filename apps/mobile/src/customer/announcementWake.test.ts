import { describe, expect, it } from "vitest";
import { subscribeAnnouncementWake, type WakeSources } from "./announcementWake";

/** Two fake event sources the test can fire, and see unsubscribed. */
function fakeSources() {
  const app = new Set<(s: string) => void>();
  const notes = new Set<(d: unknown) => void>();
  const sources: WakeSources = {
    onAppState: (l) => {
      app.add(l);
      return { remove: () => void app.delete(l) };
    },
    onNotificationReceived: (l) => {
      notes.add(l);
      return { remove: () => void notes.delete(l) };
    },
  };
  return {
    sources,
    appState: (s: string) => app.forEach((l) => l(s)),
    notify: (data: unknown) => notes.forEach((l) => l(data)),
    listeners: () => app.size + notes.size,
  };
}

describe("the bell looks again when an announcement may have arrived", () => {
  it("when the app comes back to the foreground", () => {
    const f = fakeSources();
    const wakes: string[] = [];
    subscribeAnnouncementWake(f.sources, (r) => wakes.push(r));
    f.appState("background");
    f.appState("inactive");
    expect(wakes).toEqual([]);
    f.appState("active");
    expect(wakes).toEqual(["foreground"]);
  });

  it("when a shop's announcement push arrives while the app is open - and not for other pushes", () => {
    const f = fakeSources();
    const wakes: string[] = [];
    subscribeAnnouncementWake(f.sources, (r) => wakes.push(r));
    f.notify({ url: "https://getchairback.com/book/fades?opening=op_1" });
    f.notify({ url: "https://getchairback.com/book/fades" });
    f.notify(null);
    expect(wakes).toEqual([]);
    f.notify({ url: "https://getchairback.com/book/fades?announcement=bc_1" });
    expect(wakes).toEqual(["announcement"]);
  });

  it("stops listening when the screen goes away", () => {
    const f = fakeSources();
    let wakes = 0;
    const stop = subscribeAnnouncementWake(f.sources, () => wakes++);
    expect(f.listeners()).toBe(2);
    stop();
    expect(f.listeners()).toBe(0);
    f.appState("active");
    f.notify({ url: "https://getchairback.com/book/fades?announcement=bc_1" });
    expect(wakes).toBe(0);
  });
});
