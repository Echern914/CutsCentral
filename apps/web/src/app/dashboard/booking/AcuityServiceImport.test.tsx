import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AcuityServiceImport } from "./AcuityServiceImport";
import {
  importAcuityServicesAction,
  previewAcuityServiceImportAction,
  type AcuityImportPreview,
} from "./actions";

vi.mock("./actions", () => ({
  previewAcuityServiceImportAction: vi.fn(),
  importAcuityServicesAction: vi.fn(),
}));

/**
 * The owner's side of "Import services from Acuity": nothing happens until
 * they ask, they see every service before anything is added, and only the
 * ones marked New are sent. Made-up data.
 */

const mockPreview = vi.mocked(previewAcuityServiceImportAction);
const mockImport = vi.mocked(importAcuityServicesAction);
const toast = vi.fn();

const PREVIEW: AcuityImportPreview = {
  rows: [
    { acuityId: "102", name: "Beard Trim", durationMin: 20, price: 15, category: "Beard", status: "exists" },
    { acuityId: "101", name: "Classic Trim", durationMin: 30, price: 35.5, category: "Trims", status: "new" },
    { acuityId: "106", name: "Friends Rate", durationMin: 30, price: 10, category: null, status: "private" },
    { acuityId: "104", name: "Scalp Treatment", durationMin: 45, price: null, category: null, status: "new" },
  ],
  newGroups: ["Trims"],
};

beforeEach(() => {
  mockPreview.mockReset();
  mockImport.mockReset();
  toast.mockClear();
});

async function openPreview(data: AcuityImportPreview = PREVIEW) {
  mockPreview.mockResolvedValue({ ok: true, data });
  render(<AcuityServiceImport toast={toast} />);
  fireEvent.click(screen.getByRole("button", { name: "Check my Acuity services" }));
  await screen.findByRole("status");
}

describe("the preview", () => {
  it("reads nothing from Acuity until the owner asks", () => {
    render(<AcuityServiceImport toast={toast} />);
    expect(mockPreview).not.toHaveBeenCalled();
    expect(screen.queryByText("Classic Trim")).toBeNull();
  });

  it("lists every service with its length, price and category, and why any is left out", async () => {
    await openPreview();
    expect(screen.getByRole("status").textContent).toBe(
      "2 new services to add, in 1 new group (Trims). Services already here stay exactly as they are.",
    );
    expect(screen.getByText("30 min · $35.50 · Trims")).toBeTruthy();
    expect(screen.getByText("45 min · No price")).toBeTruthy();
    expect(screen.getByText("Already in ChairBack")).toBeTruthy();
    expect(screen.getByText(/Private in Acuity/)).toBeTruthy();
    // New ones first.
    const names = screen.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
    expect(names).toEqual(["Classic Trim", "Scalp Treatment", "Beard Trim", "Friends Rate"]);
  });

  it("says so when everything is already here, with nothing to confirm", async () => {
    await openPreview({
      rows: [{ ...PREVIEW.rows[0]! }],
      newGroups: [],
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Everything from Acuity is already here. Nothing to add.",
    );
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
  });

  it("an Acuity it can't reach says so and can be tried again", async () => {
    mockPreview.mockResolvedValue({ ok: false, error: "acuity_unavailable" });
    render(<AcuityServiceImport toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "Check my Acuity services" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn.t reach Acuity/);
    expect(screen.getByRole("button", { name: "Check my Acuity services" })).toBeTruthy();
  });
});

describe("confirming", () => {
  it("sends only the services marked New, and only on the owner's tap", async () => {
    await openPreview();
    expect(mockImport).not.toHaveBeenCalled();
    mockImport.mockResolvedValue({ ok: true, created: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 services" }));
    await waitFor(() => expect(mockImport).toHaveBeenCalledWith(["101", "104"]));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Added 2 services from Acuity", "success"));
    // Back to the button, so the list the owner saw is not left looking pending.
    expect(screen.getByRole("button", { name: "Check my Acuity services" })).toBeTruthy();
  });

  it("a failed import says nothing changed and keeps the list", async () => {
    await openPreview();
    mockImport.mockResolvedValue({ ok: false, error: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 services" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't add them. Nothing was changed - try again.", "error"),
    );
    expect(screen.getByText("Classic Trim")).toBeTruthy();
  });

  it("Cancel adds nothing", async () => {
    await openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockImport).not.toHaveBeenCalled();
    expect(screen.queryByText("Classic Trim")).toBeNull();
  });
});
