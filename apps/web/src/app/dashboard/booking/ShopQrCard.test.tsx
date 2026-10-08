import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * 🔴 "Download PNG" and "Print card" do nothing inside the iPhone app: the
 * WebView has no downloads and no print sheet. They looked fine and a barber
 * tapped them again and again. In the app they are replaced by where they
 * work; in a browser they are unchanged.
 */

const inApp = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => inApp.value }));
const getShopQrAction = vi.hoisted(() => vi.fn());
vi.mock("./qrActions", () => ({ getShopQrAction }));

const { ShopQrCard } = await import("./ShopQrCard");

const QR = {
  url: "https://getchairback.com/book/dees",
  svg: "<svg></svg>",
  png: "data:image/png;base64,AAAA",
};

beforeEach(() => {
  getShopQrAction.mockReset();
  getShopQrAction.mockResolvedValue({ ok: true, qr: QR });
});

async function showCode() {
  render(<ShopQrCard bookUrl={QR.url} shopName="Dee's" toast={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Show my QR code" }));
  await screen.findByRole("img", { name: /QR code linking to/ });
}

describe("the QR card", () => {
  it("in a browser, offers Download and Print", async () => {
    inApp.value = false;
    await showCode();
    expect(screen.getByRole("link", { name: "Download PNG" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print card" })).toBeTruthy();
  });

  it("🔴 in the app, offers neither, and says where they work", async () => {
    inApp.value = true;
    await showCode();
    expect(screen.queryByRole("link", { name: "Download PNG" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Print card" })).toBeNull();
    expect(screen.getByText(/open your dashboard in a web browser/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });
});
