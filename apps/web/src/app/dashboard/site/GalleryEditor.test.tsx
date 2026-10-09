import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { GalleryItem } from "@chairback/config/constants";

/**
 * Adding several gallery photos at once.
 *
 *  - 🔴 a caption typed while the batch uploaded was thrown away when the
 *    batch landed, because it appended to the list it STARTED with;
 *  - a photo in the middle that failed left no trace once a later one
 *    succeeded, because each upload clears the hook's error.
 */

const pending = vi.hoisted(() => [] as ((url: string | null) => void)[]);
vi.mock("./useImageUpload", () => ({
  useImageUpload: () => ({
    uploading: false,
    error: null,
    clearError: () => {},
    accept: "image/jpeg,image/png",
    upload: () => new Promise<string | null>((resolve) => pending.push(resolve)),
  }),
}));

const { GalleryEditor } = await import("./GalleryEditor");

function Harness() {
  const [items, setItems] = useState<GalleryItem[]>([{ url: "https://x.test/a.jpg" }]);
  return (
    <>
      <GalleryEditor items={items} onChange={setItems} />
      <output data-testid="items">{JSON.stringify(items)}</output>
    </>
  );
}

const photo = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("uploading several photos at once", () => {
  it("🔴 keeps a caption typed while they uploaded, and counts the one that failed", async () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo("b.jpg"), photo("c.jpg"), photo("d.jpg")] } });

    // While the batch runs, the barber captions the photo that was already there.
    fireEvent.change(screen.getByLabelText("Caption for photo 1"), { target: { value: "Fresh fade" } });

    await act(async () => pending.shift()!("https://x.test/b.jpg"));
    await act(async () => pending.shift()!(null));
    await act(async () => pending.shift()!("https://x.test/d.jpg"));

    const items = JSON.parse(screen.getByTestId("items").textContent!) as GalleryItem[];
    expect(items.map((i) => i.url)).toEqual([
      "https://x.test/a.jpg",
      "https://x.test/b.jpg",
      "https://x.test/d.jpg",
    ]);
    expect(items[0]!.caption).toBe("Fresh fade");
    expect(screen.getByRole("alert").textContent).toMatch(/1 photo didn.t upload/);
  });
});
