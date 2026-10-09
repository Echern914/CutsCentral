import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * 🔴 Gallery captions on the classic shop page were `opacity-0` until a MOUSE
 * hovered, so on a phone (most visitors) no caption was ever seen. They are now
 * visible by default and fade only on a device that can hover.
 *
 * jsdom can't evaluate a media query, so this pins the classes: no bare
 * `opacity-0`, and the hide is scoped to `(hover:hover)`.
 */

const { Gallery } = await import("./pageSections");

describe("gallery captions", () => {
  it("are visible without a hover, and fade only where hovering exists", () => {
    render(
      <Gallery
        data={{ name: "Dee's", gallery: [{ url: "https://img.test/1.jpg", caption: "Fresh fade" }] } as never}
        theme={{ muted: "#999", border: "#222" } as never}
        layout={{ radius: "12px" } as never}
      />,
    );
    const caption = screen.getByText("Fresh fade");
    const classes = caption.className.split(/\s+/);
    expect(classes).not.toContain("opacity-0");
    expect(classes).toContain("[@media(hover:hover)]:opacity-0");
  });
});
