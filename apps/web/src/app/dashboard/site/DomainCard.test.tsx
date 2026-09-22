import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import { DomainCard } from "./DomainCard";
import type { DomainStatus } from "./domainActions";

vi.mock("./domainActions", () => ({
  connectDomainAction: vi.fn(),
  verifyDomainAction: vi.fn(),
  removeDomainAction: vi.fn(),
}));

/**
 * The instructions ARE the feature here. Three of three owners who connected a
 * domain in production never finished DNS; the card they saw showed two
 * records and the word "waiting". These pin what the new one says.
 */

const records = [
  { type: "A", name: "@", value: "76.76.21.21" },
  { type: "CNAME", name: "www", value: "cname.vercel-dns.com" },
  { type: "TXT", name: "_chairback.example.com", value: "chairback-verify=tok123" },
];

function status(over: Partial<DomainStatus> = {}): DomainStatus {
  return {
    available: true,
    domain: null,
    verifiedAt: null,
    records: [],
    dns: null,
    vercel: null,
    ...over,
  };
}

const mount = (s: DomainStatus) =>
  render(
    <ToastProvider>
      <DomainCard initial={s} />
    </ToastProvider>,
  );

describe("before connecting", () => {
  it("warns that connecting replaces whatever site is on the domain", () => {
    mount(status());
    expect(screen.getByText(/replaces that site/i)).toBeTruthy();
    expect(screen.getByText(/Email on the domain is not affected/i)).toBeTruthy();
  });
});

describe("connected, not yet verified", () => {
  it("shows all three records and, before any check, says so", () => {
    mount(status({ domain: "example.com", records }));
    expect(screen.getByText("TXT")).toBeTruthy();
    expect(screen.getByText("_chairback.example.com")).toBeTruthy();
    expect(screen.getByText("chairback-verify=tok123")).toBeTruthy();
    expect(screen.getAllByText("Not checked yet")).toHaveLength(3);
    expect(screen.getByText("Not connected yet")).toBeTruthy();
  });

  it("tells the owner to delete a parking record on @", () => {
    mount(status({ domain: "example.com", records }));
    expect(screen.getByText(/Two A records on @ and the wrong one wins/i)).toBeTruthy();
  });

  it("names what each record currently points at, per row", () => {
    mount(
      status({
        domain: "example.com",
        records,
        dns: {
          apex: { status: "points_elsewhere", found: "203.0.113.9" },
          www: { status: "points_here", found: "cname.vercel-dns.com" },
          txt: { status: "missing" },
          checkedAt: new Date().toISOString(),
        },
      }),
    );
    // The A record: the thing the old card could never say.
    expect(screen.getByText("203.0.113.9")).toBeTruthy();
    expect(screen.getByText(/change it to the value shown/i)).toBeTruthy();
    // The CNAME is right.
    expect(screen.getAllByText("✓ Found")).toHaveLength(1);
    // The TXT is not there.
    expect(screen.getByText("Not there yet")).toBeTruthy();
  });

  it("distinguishes 'wrong token' from 'missing' on the TXT row", () => {
    mount(
      status({
        domain: "example.com",
        records,
        dns: {
          apex: { status: "points_here", found: "76.76.21.21" },
          www: { status: "points_here", found: "cname.vercel-dns.com" },
          txt: { status: "wrong" },
          checkedAt: new Date().toISOString(),
        },
      }),
    );
    expect(screen.getByText(/Has a different value/i)).toBeTruthy();
  });

  it("says 'could not check' rather than 'missing' when the lookup errored", () => {
    mount(
      status({
        domain: "example.com",
        records,
        dns: {
          apex: { status: "error", found: null },
          www: { status: "error", found: null },
          txt: { status: "error" },
          checkedAt: new Date().toISOString(),
        },
      }),
    );
    expect(screen.getAllByText(/Couldn't check just now/i)).toHaveLength(3);
    expect(screen.queryByText("Not there yet")).toBeNull();
  });

  it("is Connected only on verifiedAt, never on Vercel's green alone", () => {
    mount(
      status({
        domain: "example.com",
        records,
        vercel: { verified: true, misconfigured: false, verification: [] },
      }),
    );
    expect(screen.getByText("Not connected yet")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
  });
});

describe("verified", () => {
  it("says it is working, www included, over https", () => {
    mount(status({ domain: "example.com", records, verifiedAt: new Date().toISOString() }));
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/with or without www/i)).toBeTruthy();
    expect(screen.queryByText("TXT")).toBeNull(); // nothing left to set
  });
});
