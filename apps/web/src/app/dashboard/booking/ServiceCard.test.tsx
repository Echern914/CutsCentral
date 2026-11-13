import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BUSINESS_TYPES } from "@chairback/config/businessTypes";
import { ServiceCard, serviceSummary } from "./ServiceCard";

/**
 * The Services list card.
 *
 * The list was hairline rows that ran everything onto one line, including
 * EVERY per-weekday override spelled out - "Sun $55, Mon $55, Tue $55, Wed
 * $55, Thu $55, Fri $60, Sat $60" - so nine services read as one grey
 * paragraph and on a phone the override list pushed the buttons off the right
 * edge.
 *
 * Two things are pinned here: the summary stays SHORT whatever the service is
 * configured to do, and the card cannot overflow a narrow screen.
 */

const BASE = {
  durationMin: 30,
  price: 35,
  offeredByAll: false,
  staffNames: ["Marcus"],
  customHours: null,
};

describe("serviceSummary", () => {
  it("says the four things worth knowing", () => {
    expect(serviceSummary(BASE)).toEqual({
      duration: "30 min",
      price: "$35",
      varies: null,
      barbers: "Marcus",
      availability: "Regular hours",
    });
  });

  it("COUNTS the overrides instead of listing them", () => {
    // The old row printed one "Fri $60" fragment per weekday. Seven of them on
    // a phone is what pushed Edit/Duplicate/Remove off the screen.
    const s = serviceSummary({
      ...BASE,
      priceOverrides: { "0": 55, "1": 55, "2": 55, "3": 55, "4": 55, "5": 60, "6": 60 },
      durationOverrides: { "5": 25 },
    });
    expect(s.price).toBe("$35");
    expect(s.duration).toBe("30 min");
    expect(s.varies).toBe("varies by day");
    // Crucially, no weekday names at all.
    expect(s.price).not.toMatch(/Sun|Mon|Fri/);
  });

  it("treats a time-of-day window as varying too", () => {
    const s = serviceSummary({ ...BASE, timeOverrides: [{ s: 1260, e: 1440 }] });
    expect(s.varies).toBe("varies by day");
  });

  it("says 'varies by day' ONCE when both the price and the length vary", () => {
    // The screenshot caught this: two independent suffixes rendered
    // "30 min · varies by day · $35 · varies by day" in one short line.
    const s = serviceSummary({
      ...BASE,
      priceOverrides: { "6": 45 },
      durationOverrides: { "5": 25 },
    });
    expect(s.varies).toBe("varies by day");
    expect(`${s.duration} ${s.price} ${s.varies}`.match(/varies by day/g)).toHaveLength(1);
  });

  it("says a service is UNPRICED rather than free", () => {
    // "$0" would read as free on a screen the barber uses to sanity-check the
    // menu. It has no price, which is a different thing.
    expect(serviceSummary({ ...BASE, price: null }).price).toBe("No price set");
  });

  it("collapses a long barber list to two names and a count", () => {
    expect(
      serviceSummary({ ...BASE, staffNames: ["Marcus", "Dre", "Sam", "Kay"] }).barbers,
    ).toBe("Marcus, Dre +2");
  });

  it("says 'All <providers>' in the shop's own words when offered by everyone", () => {
    expect(
      serviceSummary({
        ...BASE,
        offeredByAll: true,
        staffNames: ["Marcus", "Dre"],
        vocab: BUSINESS_TYPES.barber.vocabulary,
      }).barbers,
    ).toBe("All barbers");
    expect(
      serviceSummary({
        ...BASE,
        offeredByAll: true,
        staffNames: ["Ada", "Kim"],
        vocab: BUSINESS_TYPES.nails.vocabulary,
      }).barbers,
    ).toBe("All nail techs");
  });

  it("names the gap when nobody offers it", () => {
    // Silence here would hide a service that can never be booked.
    expect(
      serviceSummary({ ...BASE, staffNames: [], vocab: BUSINESS_TYPES.barber.vocabulary })
        .barbers,
    ).toBe("No barber assigned");
  });

  it("falls back to NEUTRAL words when no vocabulary is supplied", () => {
    // 🔴 The fallback must be generic, never barbershop. An omitted vocabulary
    // means "we do not know what this shop calls its people", and answering
    // "barber" is exactly the silent classification this work exists to stop.
    expect(serviceSummary({ ...BASE, offeredByAll: true }).barbers).toBe("All providers");
    expect(serviceSummary({ ...BASE, staffNames: [] }).barbers).toBe("No provider assigned");
  });

  it("uses the custom-hours summary when the service is not on regular hours", () => {
    expect(
      serviceSummary({ ...BASE, customHours: "Fri 6-11 PM" }).availability,
    ).toBe("Fri 6-11 PM");
  });
});

function Card(props: Partial<Parameters<typeof ServiceCard>[0]> = {}) {
  return (
    <ul>
      <ServiceCard name="Skin Fade" summary={serviceSummary(BASE)} onOpen={() => {}} {...props} />
    </ul>
  );
}

describe("the card", () => {
  it("shows the service name clearly", () => {
    render(<Card />);
    expect(screen.getByText("Skin Fade")).toBeVisible();
  });

  it("shows duration, price, barber and availability", () => {
    render(<Card />);
    const line = screen.getByText(/30 min/);
    expect(line).toHaveTextContent("30 min");
    expect(line).toHaveTextContent("$35");
    expect(line).toHaveTextContent("Marcus");
    expect(line).toHaveTextContent("Regular hours");
  });

  it("never repeats 'varies by day' on the rendered line", () => {
    render(
      <Card
        summary={serviceSummary({
          ...BASE,
          priceOverrides: { "6": 45 },
          durationOverrides: { "5": 25 },
        })}
      />,
    );
    const text = screen.getByText(/30 min/).textContent ?? "";
    expect(text.match(/varies by day/g)).toHaveLength(1);
  });

  it("🔴 is ONE way in: the whole card opens the service, and nothing else is on it", () => {
    // It used to carry an eye, Edit, Dates, Duplicate and Remove along its
    // edge - five 16px links, Remove a thumb's width from Edit.
    const onOpen = vi.fn();
    render(<Card onOpen={onOpen} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is named for the service, with the summary as its description", () => {
    render(<Card />);
    const open = screen.getByRole("button", { name: "Edit Skin Fade" });
    expect(open).toHaveAccessibleDescription(/30 min · \$35 · Marcus · Regular hours/);
  });

  it("says custom hours to a screen reader, where the star says it to the eye", () => {
    render(<Card flagged />);
    expect(screen.getByRole("button", { name: "Edit Skin Fade" })).toHaveAccessibleDescription(
      /^Custom hours\. /,
    );
  });

  it("is tall enough for a thumb", () => {
    render(<Card />);
    expect(screen.getByRole("button", { name: "Edit Skin Fade" }).className).toContain("min-h-[64px]");
  });
});

describe("hidden from clients", () => {
  it("says Hidden beside the name when the barber has hidden it", () => {
    render(<Card hidden />);
    expect(screen.getByTestId("service-hidden-badge")).toHaveTextContent("Hidden");
  });

  it("says nothing extra for a service clients can see", () => {
    render(<Card />);
    expect(screen.queryByTestId("service-hidden-badge")).toBeNull();
  });
});

describe("what is worth knowing before opening it", () => {
  it("shows the note it is given", () => {
    render(<Card note="2 special dates" />);
    expect(screen.getByText("2 special dates")).toBeVisible();
  });

  it("draws the calendar colour as a bar, and no bar without one", () => {
    const { unmount } = render(<Card color="#22C55E" />);
    expect(screen.getByTestId("service-color-bar")).toHaveStyle({ backgroundColor: "#22C55E" });
    unmount();
    render(<Card />);
    expect(screen.queryByTestId("service-color-bar")).toBeNull();
  });
});

describe("responsive", () => {
  it("truncates a long name rather than widening the card", () => {
    render(<Card name="The VIP Package — Haircut, Beard Sculpt & Hot Towel Finish" />);
    expect(screen.getByText(/The VIP Package/)).toHaveClass("truncate");
  });

  it("lets the summary WRAP instead of hiding who does it and when", () => {
    // Truncated, "30 min · $35 · vari…" was all that fit on a phone - two of
    // the four facts were cut away.
    render(<Card />);
    const line = screen.getByText(/30 min/);
    expect(line.className).not.toMatch(/truncate/);
  });

  it("lets the text block shrink, so a long name cannot push the card wider than the phone", () => {
    // min-w-0 is what lets truncate engage inside a flex child. It is
    // load-bearing and invisible in a happy-path test.
    render(<Card />);
    const block = screen.getByText("Skin Fade").parentElement?.parentElement;
    expect(block?.className).toContain("min-w-0");
    expect(block?.className).toContain("flex-1");
  });

  it("applies the same shape to a VIP service as to a plain one", () => {
    // "Regular" and "VIP" are just names - there is no second code path, and
    // this is what keeps a long menu scannable.
    const { container: plain } = render(<Card name="Haircut" />);
    const plainClass = plain.querySelector("li")!.className;
    const { container: vip } = render(<Card name="VIP Package" />);
    expect(vip.querySelector("li")!.className).toBe(plainClass);
  });
});
