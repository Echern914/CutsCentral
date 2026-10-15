import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

/**
 * The "Switching from Booksy or TheCut" guide's button lands on
 * /dashboard/clients?import=1, and the importer must already be open there -
 * not one more tap away behind a button the barber has to find.
 */
describe("ClientsControls - the importer", () => {
  afterEach(() => {
    cleanup();
    nav.push.mockReset();
  });

  it("opens straight away when the guide links here with ?import=1", () => {
    nav.params = new URLSearchParams("import=1");
    render(<ClientsControls />);
    expect(screen.getByText("Import your client list")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("is otherwise behind the Import clients button", () => {
    nav.params = new URLSearchParams();
    render(<ClientsControls />);
    expect(screen.queryByText("Import your client list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import clients" }));
    expect(screen.getByText("Import your client list")).toBeTruthy();
  });

  it("a filter change drops ?import=1, so it does not reopen the importer", () => {
    nav.params = new URLSearchParams("import=1&q=theo");
    render(<ClientsControls />);
    // The first select is the sort order.
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "name" } });
    expect(nav.push.mock.calls).toEqual([["/dashboard/clients?q=theo&sort=name"]]);
  });
});
