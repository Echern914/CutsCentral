-- Per-shop Twilio numbers (structural fix for wrong-shop routing on the
-- shared line). Nullable + unique; every existing shop stays on the shared
-- platform number until the operator assigns one, so this changes no runtime
-- behavior on its own.
ALTER TABLE "Shop" ADD COLUMN "twilioNumber" TEXT;

CREATE UNIQUE INDEX "Shop_twilioNumber_key" ON "Shop"("twilioNumber");
