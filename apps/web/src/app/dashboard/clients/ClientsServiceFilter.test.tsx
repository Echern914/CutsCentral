import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within as inside } from "@testing-library/react";

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => nav.params,
}));
vi.mock("../actions", () => ({
  addClientAction: vi.fn(),
  searchClientsByNameAction: vi.fn(),
  importClientsAction: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ClientsControls } = await import("./ClientsControls");
const { ClientsList } = await import("./ClientsList");

/**
 * "BOOKED A SERVICE" ON THE CLIENTS LIST.
 *
 * A barber asked to see everyone who booked braids or retwists in a stretch of
 * time. The list is the API's; these pin what the page sends and shows: the
 * service and its window travel together, the window reads 90 days whenever
 * the URL has none (as the API does), and a failed options read hides the
 * filter rather than breaking the rest of the bar.
 */
const OPTIONS = [
  { key: "group:g1", label: "Retwist/Braids", kind: "group" as const },
  { key: "id:s1", label: "Retwist + cut", kind: "menu" as const },
  { key: "id:s2", label: "Haircut", kind: "menu" as const },
  { key: "name:braids", label: "Braids", kind: "synced" as const },
];

const serviceSelect = () => screen.getByRole("combobox", { name: "Booked a service" }) as HTMLSelectElement;
const withinSelect = () => screen.queryByRole("combobox", { name: "Booked within" }) as HTMLSelectElement | null;

afterEach(() => {
  cleanup();
  nav.push.mockReset();
  nav.params = new URLSearchParams();
});

describe("the service filter", () => {
  it("lists groups, then services, then old-system names, under their own headings", () => {
    render(<ClientsControls serviceOptions={OPTIONS} />);
    const groups = [...serviceSelect().querySelectorAll("optgroup")].map((g) => [
      g.label,
      [...g.querySelectorAll("option")].map((o) => o.textContent),
    ]);
    expect(groups).toEqual([
      ["Groups", ["Retwist/Braids"]],
      ["Services", ["Retwist + cut", "Haircut"]],
      ["From your old booking system", ["Braids"]],
    ]);
    expect(serviceSelect().value).toBe("");
    // No window until there is a service for it to apply to.
    expect(withinSelect()).toBeNull();
  });

  it("🔴 picking a service sends it with its window, 90 days, and back to page 1", () => {
    nav.params = new URLSearchParams("tier=GOLD&page=3");
    render(<ClientsControls serviceOptions={OPTIONS} />);
    fireEvent.change(serviceSelect(), { target: { value: "group:g1" } });
    expect(nav.push.mock.calls).toEqual([["/dashboard/clients?tier=GOLD&service=group%3Ag1&within=90"]]);
  });

  it("the window offers 30 days to any time, and changes alone", () => {
    nav.params = new URLSearchParams("service=id%3As1&within=90");
    render(<ClientsControls serviceOptions={OPTIONS} />);
    const w = withinSelect()!;
    expect([...w.options].map((o) => o.textContent)).toEqual([
      "Last 30 days",
      "Last 90 days",
      "Last year",
      "Any time",
    ]);
    fireEvent.change(w, { target: { value: "any" } });
    expect(nav.push.mock.calls).toEqual([["/dashboard/clients?service=id%3As1&within=any"]]);
  });

  it("🔴 a URL with a service and no window reads 90 days, as the API does", () => {
    nav.params = new URLSearchParams("service=id%3As1");
    render(<ClientsControls serviceOptions={OPTIONS} />);
    expect(withinSelect()!.value).toBe("90");
    nav.params = new URLSearchParams("service=id%3As1&within=7");
    cleanup();
    render(<ClientsControls serviceOptions={OPTIONS} />);
    expect(withinSelect()!.value).toBe("90");
  });

  it("Any service clears the service and its window together", () => {
    nav.params = new URLSearchParams("service=id%3As1&within=30&q=jo");
    render(<ClientsControls serviceOptions={OPTIONS} />);
    fireEvent.change(serviceSelect(), { target: { value: "" } });
    expect(nav.push.mock.calls).toEqual([["/dashboard/clients?q=jo"]]);
  });

  it("a link to a service no longer offered still says it is filtering", () => {
    nav.params = new URLSearchParams("service=id%3Agone");
    render(<ClientsControls serviceOptions={OPTIONS} />);
    expect(serviceSelect().value).toBe("id:gone");
    expect(inside(serviceSelect()).getByText("A service no longer listed")).toBeTruthy();
  });

  it("🔴 a failed options read hides the filter; the rest of the bar still works", () => {
    render(<ClientsControls serviceOptions={null} />);
    expect(screen.queryByRole("combobox", { name: "Booked a service" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Loyalty tier" })).toBeTruthy();
  });

  it("a shop with no services shows no filter", () => {
    render(<ClientsControls serviceOptions={[]} />);
    expect(screen.queryByRole("combobox", { name: "Booked a service" })).toBeNull();
  });
});

describe("an empty list", () => {
  it("🔴 under a filter says none match, not 'add your first client'", () => {
    render(<ClientsList clients={[]} filtered />);
    expect(screen.getByText("No clients match these filters.")).toBeTruthy();
    expect(screen.queryByText(/Add client/)).toBeNull();
  });

  it("with no filter still points at Add client", () => {
    render(<ClientsList clients={[]} />);
    expect(screen.getByText(/Use “Add client” for walk-ins/)).toBeTruthy();
  });
});
