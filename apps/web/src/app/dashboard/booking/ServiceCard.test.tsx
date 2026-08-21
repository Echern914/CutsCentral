import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  it("says 'All barbers' when the service is offered by everyone", () => {
    expect(
      serviceSummary({ ...BASE, offeredByAll: true, staffNames: ["Marcus", "Dre"] })
        .barbers,
    ).toBe("All barbers");
  });

  it("names the gap when nobody offers it", () => {
    // Silence here would hide a service that can never be booked.
    expect(serviceSummary({ ...BASE, staffNames: [] }).barbers).toBe(
      "No barber assigned",
    );
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
      <ServiceCard
        name="Skin Fade"
        summary={serviceSummary(BASE)}
        actions={
          <>
            <button>Edit</button>
            <button>Duplicate</button>
            <button>Remove</button>
          </>
        }
        {...props}
      />
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

  it("keeps Edit, Duplicate and Remove in that order on every card", () => {
    render(<Card />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Edit", "Duplicate", "Remove"]);
  });
});

describe("selected state", () => {
  it("is visibly stronger when the service is open in the editor", () => {
    const { container, rerender } = render(<Card />);
    const idle = container.querySelector("li");
    expect(idle?.className).toContain("border-gold/25");
    expect(idle).not.toHaveAttribute("aria-current");

    rerender(<Card selected />);
    const active = container.querySelector("li");
    // Full-strength gold, a gold wash, and announced to AT.
    expect(active?.className).toContain("border-gold");
    expect(active?.className).not.toContain("border-gold/25");
    expect(active).toHaveAttribute("aria-current", "true");
  });

  it("does not change the border WIDTH between states", () => {
    // A 1px -> 2px swap on select makes every other card jump. Both states use
    // the same `border`, only the colour differs.
    const { container, rerender } = render(<Card />);
    const idle = container.querySelector("li")!.className;
    rerender(<Card selected />);
    const active = container.querySelector("li")!.className;
    for (const cls of [idle, active]) {
      expect(cls).toContain("border ");
      expect(cls).not.toMatch(/border-2|border-\[2px\]/);
    }
  });
});

describe("responsive", () => {
  it("truncates a long name rather than widening the card", () => {
    render(<Card name="The VIP Package — Haircut, Beard Sculpt & Hot Towel Finish" />);
    expect(screen.getByText(/The VIP Package/)).toHaveClass("truncate");
  });

  it("truncates the summary from sm up, where it shares the row", () => {
    render(<Card />);
    expect(screen.getByText(/30 min/)).toHaveClass("sm:truncate");
  });

  it("lets the summary WRAP on a phone instead of hiding the barber", () => {
    // At 390px, sharing the row with three buttons left room for
    // "30 min · $35 · vari…" - two of the four facts were truncated away. The
    // summary must not carry an unconditional truncate.
    render(<Card />);
    const line = screen.getByText(/30 min/);
    expect(line.className.split(/s+/)).not.toContain("truncate");
  });

  it("gives the summary the full width on a phone so the buttons wrap under it", () => {
    const { container } = render(<Card />);
    const textBlock = container.querySelector("li > div > div");
    expect(textBlock?.className).toContain("basis-full");
    expect(textBlock?.className).toContain("sm:basis-auto");
  });

  it("lets the actions wrap under the summary on a narrow screen", () => {
    // flex-wrap is what stops the row scrolling sideways on a phone; min-w-0
    // on the text block is what lets truncate actually engage inside a flex
    // child. Both are load-bearing and neither is visible in a happy-path test.
    const { container } = render(<Card />);
    const row = container.querySelector("li > div");
    expect(row?.className).toContain("flex-wrap");
    expect(row?.querySelector("div")?.className).toContain("min-w-0");
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
