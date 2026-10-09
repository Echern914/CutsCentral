-- The Lock Screen widget may hide client names (the widget reads this through
-- GET /api/next-up). Existing rows keep showing them, as the push preview does.
ALTER TABLE "BarberNotifyPref" ADD COLUMN "lockScreenNames" BOOLEAN NOT NULL DEFAULT true;
