import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SquareSetup } from "./SquareSetup";
import {
  getSquareSetupAction,
  setSquareModeAction,
  setSquareTeamMemberAction,
  type SquareSetupData,
} from "./actions";

vi.mock("./actions", () => ({
  getSquareSetupAction: vi.fn(),
  setSquareLocationAction: vi.fn(async () => ({ ok: true })),
  setSquareTeamMemberAction: vi.fn(async () => ({ ok: true })),
  setSquareVariationAction: vi.fn(async () => ({ ok: true })),
  setSquareModeAction: vi.fn(async () => ({ ok: true })),
  refreshSquareCapabilityAction: vi.fn(async () => ({ ok: true })),
}));

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * THE ONE PROMISE THIS CARD MAKES: never a green light that isn't true.
 *
 * These are render assertions, not logic assertions, because the defects this
 * screen can actually ship are render defects - an enabled "Protect" button on
 * a shop that cannot write, a barber turned away with nothing on screen saying
 * so, a "not ready" with no instruction attached.
 */
const mockGet = vi.mocked(getSquareSetupAction);
const mockMode = vi.mocked(setSquareModeAction);
const mockTeam = vi.mocked(setSquareTeamMemberAction);

function data(over: Partial<SquareSetupData> = {}): SquareSetupData {
  return {
    mode: "OFF",
    bookingMode: "native",
    ready: true,
    connectionProblems: [],
    generation: 3,
    connection: {
      connected: true,
      revoked: false,
      grantedScopes: ["APPOINTMENTS_WRITE", "APPOINTMENTS_ALL_WRITE"],
      scopesCheckedAt: "2026-08-25T00:00:00.000Z",
      sellerLevelWrites: true,
      bookingEnabled: true,
      capabilityCheckedAt: "2026-08-25T00:00:00.000Z",
      outboundLocationId: "L1",
      outboundLocationName: "Main St",
    },
    preselectLocationId: null,
    locations: [{ id: "L1", name: "Main St", status: "ACTIVE" }],
    teamMembers: [
      { id: "TM1", name: "Eric Chernichaw", takenByStaffId: "st1" },
      { id: "TM2", name: "Sam Okonkwo", takenByStaffId: null },
    ],
    variations: [{ id: "VAR1", label: "Haircut - 30 min", durationMin: 30 }],
    staff: [
      {
        id: "st1",
        name: "Eric Chernichaw",
        active: true,
        bookable: true,
        teamMemberId: "TM1",
        teamMemberName: "Eric Chernichaw",
        problem: null,
      },
    ],
    services: [
      {
        id: "sv1",
        name: "Haircut",
        active: true,
        bookable: true,
        variationId: "VAR1",
        variationName: "Haircut - 30 min",
        problem: null,
      },
    ],
    blockingPairs: [],
    ...over,
  };
}

function load(d: SquareSetupData | { ok: false; error: string }) {
  if ("ok" in d) mockGet.mockResolvedValue(d);
  else mockGet.mockResolvedValue({ ok: true, data: d });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the arming switch", () => {
  it("enables Protect only when a real Square write would succeed", async () => {
    load(data());
    render(<SquareSetup apiBase="http://api.test" />);
    const protect = await screen.findByRole("button", { name: /Protect/ });
    expect(protect).toBeEnabled();
  });

  it("DISABLES Protect while anything is unmapped, and says how many", async () => {
    load(
      data({
        ready: false,
        blockingPairs: [
          {
            staffId: "st2",
            staffName: "New Hire",
            serviceId: "sv1",
            serviceName: "Haircut",
            staffProblem: "unmapped",
            serviceProblem: null,
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    const protect = await screen.findByRole("button", { name: /Protect/ });
    expect(protect).toBeDisabled();
    expect(screen.getByText(/1 barber\/service pairing still to link/)).toBeInTheDocument();
  });

  it("DISABLES Protect on a read-only token even with every mapping perfect", async () => {
    // The mappings are flawless; the seller simply never granted write
    // permission. A green light here would be a lie.
    load(data({ ready: false, connectionProblems: ["reauth_required"] }));
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByRole("button", { name: /Protect/ })).toBeDisabled();
    expect(screen.getByText(/connection is read-only/i)).toBeInTheDocument();
  });

  it("names the Square PLAN as the blocker when that is what it is", async () => {
    load(data({ ready: false, connectionProblems: ["seller_writes_unsupported"] }));
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText(/Appointments Plus or Premium is required/)).toBeInTheDocument();
  });

  it("always lets a manager step back to Off", async () => {
    load(data({ mode: "ENFORCE" }));
    render(<SquareSetup apiBase="http://api.test" />);
    const off = await screen.findByRole("button", { name: /^Off/ });
    expect(off).toBeEnabled();
    await userEvent.click(off);
    await waitFor(() => expect(mockMode).toHaveBeenCalledWith("OFF"));
  });
});

describe("a barber hired after the shop was armed", () => {
  it("shouts about it, and names the person and the service", async () => {
    // This is the state where real customers are being turned away right now.
    load(
      data({
        mode: "ENFORCE",
        ready: false,
        blockingPairs: [
          {
            staffId: "st2",
            staffName: "Marisol Vega",
            serviceId: "sv1",
            serviceName: "Haircut",
            staffProblem: "unmapped",
            serviceProblem: null,
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText(/turned away right now/)).toBeInTheDocument();
    expect(screen.getByText("Marisol Vega")).toBeInTheDocument();
  });

  it("never shows a green Protected badge while bookings are being refused", async () => {
    // The rendered QA caught exactly this: armed + one unmapped pair still read
    // "Protected", which is the single claim this card must not make falsely.
    load(
      data({
        mode: "ENFORCE",
        ready: false,
        blockingPairs: [
          {
            staffId: "st2",
            staffName: "Marisol Vega",
            serviceId: "sv1",
            serviceName: "Haircut",
            staffProblem: "unmapped",
            serviceProblem: null,
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText("Partly protected")).toBeInTheDocument();
    expect(screen.queryByText(/^Protected$/)).not.toBeInTheDocument();
  });

  it("shows the green badge only when an armed shop has no gaps at all", async () => {
    load(data({ mode: "ENFORCE", ready: true, blockingPairs: [] }));
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText("Protected")).toBeInTheDocument();
  });

  it("keeps the controlled selects showing what is actually linked", async () => {
    // A controlled <select> whose value never lands renders "Not linked" over a
    // row whose chip says "Linked" - two opposite claims in one card.
    load(data());
    render(<SquareSetup apiBase="http://api.test" />);
    const barber = await screen.findByRole("combobox", {
      name: "Square team member for Eric Chernichaw",
    });
    expect((barber as HTMLSelectElement).value).toBe("TM1");
    expect((screen.getByRole("combobox", { name: "Square location" }) as HTMLSelectElement).value).toBe("L1");
  });

  it("says nothing alarming when the shop is merely not armed yet", async () => {
    load(data({ mode: "OFF", ready: false, blockingPairs: [] }));
    render(<SquareSetup apiBase="http://api.test" />);
    await screen.findByText(/Square calendar protection/);
    expect(screen.queryByText(/turned away right now/)).not.toBeInTheDocument();
  });
});

describe("the mapping rows", () => {
  it("shows FULL names, never initials or ids", async () => {
    load(data());
    render(<SquareSetup apiBase="http://api.test" />);
    // The chair's own row, plus the picker option - both spell the name out.
    expect(await screen.findAllByText("Eric Chernichaw")).not.toHaveLength(0);
    expect(screen.getByRole("option", { name: /Sam Okonkwo/ })).toBeInTheDocument();
  });

  it("stops a team member already linked to another chair being picked twice", async () => {
    // One team member, one chair: two chairs on one person would double-book
    // them in Square.
    load(
      data({
        staff: [
          {
            id: "st2",
            name: "Sam Okonkwo",
            active: true,
            bookable: true,
            teamMemberId: null,
            teamMemberName: null,
            problem: "unmapped",
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    const taken = await screen.findByRole("option", { name: /Eric Chernichaw \(already linked\)/ });
    expect(taken).toBeDisabled();
  });

  it("passes the CURRENT generation back on every save", async () => {
    // The echo is what stops a tab left open across a re-authorization from
    // stamping a mapping as fresh against a different merchant.
    load(
      data({
        staff: [
          {
            id: "st2",
            name: "Sam Okonkwo",
            active: true,
            bookable: true,
            teamMemberId: null,
            teamMemberName: null,
            problem: "unmapped",
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    const select = await screen.findByRole("combobox", {
      name: "Square team member for Sam Okonkwo",
    });
    await userEvent.selectOptions(select, "TM2");
    await waitFor(() => expect(mockTeam).toHaveBeenCalledWith("st2", "TM2", 3));
  });

  it("turns each mapping problem into an instruction, not a status word", async () => {
    load(
      data({
        ready: false,
        staff: [
          {
            id: "st1",
            name: "Eric Chernichaw",
            active: true,
            bookable: true,
            teamMemberId: "TM1",
            teamMemberName: null,
            problem: "stale",
          },
        ],
        services: [
          {
            id: "sv1",
            name: "Haircut",
            active: true,
            bookable: true,
            variationId: "VAR1",
            variationName: null,
            problem: "version_stale",
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText(/Confirm again/)).toBeInTheDocument();
    expect(screen.getByText(/re-save to refresh/)).toBeInTheDocument();
  });
});

describe("empty states", () => {
  it("tells a seller with no bookable Square staff what to do in SQUARE", async () => {
    load(data({ ready: false, teamMembers: [] }));
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText(/allow online booking/)).toBeInTheDocument();
  });

  it("tells a seller with an empty Appointments catalogue what to add", async () => {
    load(data({ ready: false, variations: [] }));
    render(<SquareSetup apiBase="http://api.test" />);
    expect(
      await screen.findByText(/Add an Appointments service in Square/),
    ).toBeInTheDocument();
  });

  it("separates a Square OUTAGE from a setup problem", async () => {
    // "Square would not answer" and "a chair is unmapped" have different fixes.
    load({ ok: false, error: "square_unavailable" });
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText(/could not reach Square/i)).toBeInTheDocument();
    expect(screen.getByText(/your mappings are untouched/i)).toBeInTheDocument();
  });

  it("points a disconnected shop back at the connect card", async () => {
    load({ ok: false, error: "square_not_connected" });
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText(/Connect Square above/)).toBeInTheDocument();
  });
});

describe("progress", () => {
  it("counts linked barbers and services out of the BOOKABLE ones only", async () => {
    // An inactive barber cannot receive a booking, so counting them would show
    // "1 of 2" forever on a shop that is genuinely finished.
    load(
      data({
        staff: [
          {
            id: "st1",
            name: "Eric Chernichaw",
            active: true,
            bookable: true,
            teamMemberId: "TM1",
            teamMemberName: "Eric",
            problem: null,
          },
          {
            id: "st9",
            name: "Retired Barber",
            active: false,
            bookable: false,
            teamMemberId: null,
            teamMemberName: null,
            problem: "unmapped",
          },
        ],
      }),
    );
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByText("1 of 1 barbers linked")).toBeInTheDocument();
  });

  it("stops shouting GRANT once permission is already granted", async () => {
    // A gold primary button beside "you already have this" reads as an
    // instruction - and clicking it invalidates every mapping below.
    load(data());
    render(<SquareSetup apiBase="http://api.test" />);
    expect(await screen.findByRole("link", { name: "Re-grant permission" })).toBeInTheDocument();
  });

  it("offers the re-authorization link with the outbound scope flag", async () => {
    load(data({ ready: false, connectionProblems: ["reauth_required"] }));
    render(<SquareSetup apiBase="http://api.test" />);
    const link = await screen.findByRole("link", { name: /Grant calendar permission/ });
    expect(link).toHaveAttribute("href", "http://api.test/api/square/oauth/start?outbound=1");
  });
});
