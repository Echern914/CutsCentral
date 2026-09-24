import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

/**
 * The shop switcher lists TEAMS, not only owned shops.
 *
 * It used to render `me.shops` - shops the person owns - so a barber with
 * their own business who joined someone's team had no entry to pick, and the
 * API sent them back to their own shop anyway. Both halves had to change for
 * "independent barbers on a shop's team" to work at all.
 */

const switchShopAction = vi.fn();
vi.mock("../actions", () => ({
  switchShopAction: (...a: unknown[]) => switchShopAction(...a),
}));

const { ShopSwitcher } = await import("./ShopSwitcher");

const select = () => document.querySelector<HTMLSelectElement>('[data-qa="shop-switcher"]')!;

beforeEach(() => {
  switchShopAction.mockReset();
  switchShopAction.mockResolvedValue(undefined);
});

describe("ShopSwitcher", () => {
  it("🔴 shows the team next to the person's own shop, grouped", () => {
    render(
      <ShopSwitcher
        shops={[{ id: "own", name: "Joe's Cuts" }]}
        teams={[{ id: "team", name: "United Barbershop" }]}
        activeShopId="team"
      />,
    );
    const groups = [...select().querySelectorAll("optgroup")].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll("option")].map((o) => o.textContent),
    }));
    expect(groups).toEqual([
      { label: "Your shop", options: ["Joe's Cuts"] },
      { label: "Team", options: ["United Barbershop"] },
    ]);
    expect(select().value).toBe("team");
  });

  it("switching to the team asks for the team", () => {
    render(
      <ShopSwitcher
        shops={[{ id: "own", name: "Joe's Cuts" }]}
        teams={[{ id: "team", name: "United Barbershop" }]}
        activeShopId="own"
      />,
    );
    fireEvent.change(select(), { target: { value: "team" } });
    expect(switchShopAction).toHaveBeenCalledWith("team");
  });

  it("a member with no shop of their own gets a flat list of their teams", () => {
    render(
      <ShopSwitcher
        shops={[]}
        teams={[
          { id: "a", name: "United Barbershop" },
          { id: "b", name: "Fade Factory" },
        ]}
        activeShopId="a"
      />,
    );
    expect(select().querySelectorAll("optgroup")).toHaveLength(0);
    expect([...select().options].map((o) => o.textContent)).toEqual([
      "United Barbershop",
      "Fade Factory",
    ]);
  });

  it("a multi-shop owner with no team keeps the old, ungrouped list", () => {
    render(
      <ShopSwitcher
        shops={[
          { id: "a", name: "Downtown" },
          { id: "b", name: "Uptown" },
        ]}
        activeShopId="b"
      />,
    );
    expect(select().querySelectorAll("optgroup")).toHaveLength(0);
    expect([...select().options].map((o) => o.value)).toEqual(["a", "b"]);
  });
});
