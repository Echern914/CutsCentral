-- Per-shop opt-in for the CUSTOMER-facing "a slot just opened" auto-notify. The
-- barber's own alert (their number/device) needs no toggle; this gates the
-- outbound blast to waitlisted leads. Off by default so existing shops are
-- unchanged. See engines/slotOpened.ts.
ALTER TABLE "Shop"
  ADD COLUMN "slotOpenedTextsEnabled" BOOLEAN NOT NULL DEFAULT false;
