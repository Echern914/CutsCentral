import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemberOffers } from "./MemberOffers";

/**
 * Which offers a provider may make (Offers & codes), set by the owner on Team.
 * The API enforces it; this pins what the owner sees and what is saved.
 */
const services = [
  { id: "cut", name: "Haircut" },
  { id: "beard", name: "Beard" },
];

function show(allowed: string[], onSave = vi.fn()) {
  render(
    <MemberOffers name="Dee" stationNoun="chair" services={services} allowed={allowed} pending={false} onSave={onSave} />,
  );
  return onSave;
}

describe("a provider's offer permission on Team", () => {
  it("says what they may make, by name - none reads as none", () => {
    show([]);
    expect(screen.getByTestId("member-offers").textContent).toMatch(/^Can't make offers/);
  });

  it("names only services still on the menu", () => {
    show(["cut", "gone"]);
    expect(screen.getByTestId("member-offers").textContent).toMatch(/^Can make offers for Haircut ·/);
  });

  it("Change, tick, Save sends exactly what is ticked", () => {
    const onSave = show(["cut"]);
    fireEvent.click(screen.getByRole("button", { name: "Change which offers Dee can make" }));
    expect(screen.getByText("Offers Dee can make, on their own chair")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Haircut"));
    fireEvent.click(screen.getByLabelText("Beard"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(["beard"]);
  });

  it("Cancel saves nothing", () => {
    const onSave = show(["cut"]);
    fireEvent.click(screen.getByRole("button", { name: "Change which offers Dee can make" }));
    fireEvent.click(screen.getByLabelText("Beard"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("member-offers").textContent).toMatch(/^Can make offers for Haircut ·/);
  });
});
