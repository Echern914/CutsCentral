import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BarberClients } from "./BarberClients";
import {
  getBarberClientsAction,
  sendBarberRewardsLinkAction,
  type BarberClientRow,
} from "./barberClientActions";

vi.mock("./barberClientActions", () => ({
  getBarberClientsAction: vi.fn(),
  sendBarberRewardsLinkAction: vi.fn(async () => ({ ok: true })),
}));

/** The "Your clients" home section: quiet until the chair has clients, masked
 * phones only, one-tap resend with the server's refusals surfaced honestly. */

const getMock = vi.mocked(getBarberClientsAction);
const sendMock = vi.mocked(sendBarberRewardsLinkAction);

const row = (over: Partial<BarberClientRow> = {}): BarberClientRow => ({
  id: `c${Math.random().toString(36).slice(2, 8)}`,
  name: "Marcus L",
  maskedPhone: "··· 4567",
  lastSeen: new Date().toISOString(),
  visits: 3,
  textable: true,
  reason: null,
  ...over,
});

const payload = (clients: BarberClientRow[]) => ({
  ok: true,
  data: { chair: { staffId: "st1" }, clients, reason: null },
});

beforeEach(() => {
  vi.resetAllMocks();
  sendMock.mockResolvedValue({ ok: true });
});

describe("BarberClients", () => {
  it("renders NOTHING for a chairless seat", async () => {
    getMock.mockResolvedValue({
      ok: true,
      data: { chair: null, clients: [], reason: "no_chair_linked" },
    } as never);
    const { container } = render(<BarberClients />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders NOTHING while the clientele is empty - quiet, not an ad", async () => {
    getMock.mockResolvedValue(payload([]) as never);
    const { container } = render(<BarberClients />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows clients with masked phones and sends the link on tap", async () => {
    const c = row({ name: "Zeb Q", maskedPhone: "··· 9911" });
    getMock.mockResolvedValue(payload([c]) as never);
    render(<BarberClients />);
    await screen.findByText("Zeb Q");
    expect(screen.getByText(/··· 9911/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Text link" }));
    await screen.findByText("Sent ✓");
    expect(sendMock).toHaveBeenCalledWith(c.id);
    // Sent stays disabled - no double-tap double-texting from the UI side.
    expect((screen.getByText("Sent ✓") as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces the server's refusal as short honest copy", async () => {
    const c = row({ name: "Cool Down" });
    getMock.mockResolvedValue(payload([c]) as never);
    sendMock.mockResolvedValue({ ok: false, error: "too_soon" });
    render(<BarberClients />);
    await screen.findByText("Cool Down");
    fireEvent.click(screen.getByRole("button", { name: "Text link" }));
    await screen.findByText("Just sent - wait a few minutes.");
  });

  it("shows why an untextable client has no button", async () => {
    const c = row({ name: "Said No", textable: false, reason: "opted_out" });
    getMock.mockResolvedValue(payload([c]) as never);
    render(<BarberClients />);
    await screen.findByText("Said No");
    expect(screen.queryByRole("button", { name: "Text link" })).toBeNull();
    expect(screen.getByText("Opted out of texts.")).toBeTruthy();
  });

  it("collapses a long list behind Show all", async () => {
    const clients = Array.from({ length: 9 }, (_, i) => row({ name: `Client ${i}` }));
    getMock.mockResolvedValue(payload(clients) as never);
    render(<BarberClients />);
    await screen.findByText("Client 0");
    expect(screen.queryByText("Client 8")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all (9)" }));
    await screen.findByText("Client 8");
  });
});
