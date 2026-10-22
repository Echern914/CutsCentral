import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The admin portal's second step, on screen: the authenticator code first,
 * an emailed code as the fallback, and setting the app up once inside.
 */

const actions = vi.hoisted(() => ({
  sendAdminEmailCodeAction: vi.fn(),
  verifyAdminEmailCodeAction: vi.fn(),
  verifyAdminTotpAction: vi.fn(),
  startAdminTotpSetupAction: vi.fn(),
  confirmAdminTotpAction: vi.fn(),
}));
vi.mock("./actions", () => actions);
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { AdminTwoStepGate } = await import("./AdminTwoStepGate");
const { AdminAuthenticatorCard } = await import("./AdminAuthenticatorCard");

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  refresh.mockReset();
});

const typeCode = (label: string, code: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: code } });

describe("the gate", () => {
  it("asks for the authenticator code first, and a good one opens the portal", async () => {
    actions.verifyAdminTotpAction.mockResolvedValue({ ok: true });
    render(<AdminTwoStepGate totpEnabled emailAvailable email="er•••@x.com" />);
    expect(screen.getByText(/code from your authenticator app/)).toBeTruthy();
    typeCode("Authenticator code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(actions.verifyAdminTotpAction).toHaveBeenCalledWith("123456");
  });

  it("falls back to an emailed code, says where it went, and checks it", async () => {
    actions.sendAdminEmailCodeAction.mockResolvedValue({ ok: true, sentTo: "er•••@x.com" });
    actions.verifyAdminEmailCodeAction.mockResolvedValue({ ok: true });
    render(<AdminTwoStepGate totpEnabled emailAvailable email="er•••@x.com" />);
    fireEvent.click(screen.getByRole("button", { name: /Email me a code instead/ }));
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    await screen.findByText(/We emailed a 6-digit code to er•••@x\.com/);
    typeCode("Emailed code", "654321");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(actions.verifyAdminEmailCodeAction).toHaveBeenCalledWith("654321"));
    expect(refresh).toHaveBeenCalled();
  });

  it("with no app set up, the emailed code is the way in", () => {
    render(<AdminTwoStepGate totpEnabled={false} emailAvailable email="er•••@x.com" />);
    expect(screen.getByText(/We'll email a 6-digit code to er•••@x\.com/)).toBeTruthy();
    expect(screen.queryByLabelText("Authenticator code")).toBeNull();
  });

  it("a wrong code says so, in words, and nothing opens", async () => {
    actions.verifyAdminTotpAction.mockResolvedValue({ ok: false, error: "invalid" });
    render(<AdminTwoStepGate totpEnabled emailAvailable email={null} />);
    typeCode("Authenticator code", "111111");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("🔴 a double tap sends one check", async () => {
    let settle!: (v: { ok: boolean }) => void;
    actions.verifyAdminTotpAction.mockReturnValue(new Promise((r) => (settle = r)));
    render(<AdminTwoStepGate totpEnabled emailAvailable email={null} />);
    typeCode("Authenticator code", "123456");
    const form = screen.getByLabelText("Authenticator code").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(actions.verifyAdminTotpAction).toHaveBeenCalledTimes(1);
    settle({ ok: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("setting the app up", () => {
  it("shows the QR and key, and turns on with a code from the app", async () => {
    actions.startAdminTotpSetupAction.mockResolvedValue({ ok: true, secret: "ABCDEF", qr: "data:image/png;base64,AAA" });
    actions.confirmAdminTotpAction.mockResolvedValue({ ok: true });
    render(<AdminAuthenticatorCard enabled={false} />);
    expect(screen.getByText(/Not set up/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(await screen.findByAltText(/QR code for your authenticator app/)).toBeTruthy();
    expect(screen.getByLabelText("Setup key")).toHaveTextContent("ABCDEF");
    typeCode("Code from your app", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByText(/^On\./);
    expect(actions.confirmAdminTotpAction).toHaveBeenCalledWith("123456");
  });

  it("a code that doesn't match keeps the QR up and says why", async () => {
    actions.startAdminTotpSetupAction.mockResolvedValue({ ok: true, secret: "ABCDEF", qr: "data:image/png;base64,AAA" });
    actions.confirmAdminTotpAction.mockResolvedValue({ ok: false, error: "invalid" });
    render(<AdminAuthenticatorCard enabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    await screen.findByAltText(/QR code/);
    typeCode("Code from your app", "000000");
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("didn't match");
    expect(screen.getByAltText(/QR code/)).toBeTruthy();
  });
});
