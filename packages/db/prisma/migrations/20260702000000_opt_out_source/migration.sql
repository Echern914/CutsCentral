-- Track WHY a client is opted out so a client-initiated STOP can be
-- distinguished from a barber-side toggle. "sms_stop" rows may only be
-- reversed by the client (START webhook / rewards self-serve), never from
-- the dashboard. Additive + nullable: existing opted-out rows stay null
-- (legacy/unknown origin) and keep today's behavior.
ALTER TABLE "Client" ADD COLUMN "optOutSource" TEXT;
