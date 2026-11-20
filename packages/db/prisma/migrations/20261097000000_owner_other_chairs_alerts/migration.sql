-- The owner's "tell me about bookings on everyone else too" switch
-- (services/barberNotify.ts alertRecipients). Read for the shop owner only.
-- TRUE for every existing row: an owner who already saved notification
-- settings gets the same default as one who never opened them.
ALTER TABLE "BarberNotifyPref" ADD COLUMN IF NOT EXISTS "otherChairsEnabled" BOOLEAN NOT NULL DEFAULT true;
