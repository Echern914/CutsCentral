import { ONBOARDING_PATH, stepAfter } from "@chairback/config/onboarding";
import { API_BASE, apiGet } from "@/lib/api";
import { StepFrame } from "../StepFrame";
import { continueHref, stepState } from "../state";
import { BookingChoice } from "./BookingChoice";

export const metadata = { title: "How clients book" };

/** Setup: how clients book (replaces the old "connect your booking" screen). */
export default async function BookingStepPage() {
  const state = await stepState();
  // Square is optional/dark until configured; any non-ok means not offered.
  const square = await apiGet<{ available: boolean }>("/api/square/oauth/status");
  const connected = state.integrations.acuity ? "Acuity" : state.integrations.square ? "Square" : null;
  return (
    <StepFrame
      step="booking"
      state={state}
      title="How do clients book you?"
      lead="Pick one. You can change it later under Calendar → Settings."
    >
      <BookingChoice
        acuityHref={`${API_BASE}/api/acuity/oauth/start`}
        squareHref={square.data?.available ? `${API_BASE}/api/square/oauth/start` : null}
        connected={connected}
        nextIfNative={ONBOARDING_PATH[stepAfter("booking", { ...state.facts, bookingMode: "native" })]}
        nextIfLink={ONBOARDING_PATH[stepAfter("booking", { ...state.facts, bookingMode: "link", bookingUrl: "x" })]}
        continueHref={continueHref("booking", state)}
      />
    </StepFrame>
  );
}
