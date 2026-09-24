/* PLATFORM SWITCHES - on/off controls an operator flips from the admin portal
   without a deploy. The first key is 'sms': texting costs money per message,
   so it is switched from the admin page and every API process picks the new
   value up within seconds (apps/api/src/services/platformSwitches.ts). No row
   means nobody has used the switch yet and the environment default applies. */
CREATE TABLE "PlatformSwitch" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSwitch_pkey" PRIMARY KEY ("key")
);

/* CHECK-pinned vocabulary (the alter-under-traffic lesson: pin it now). */
ALTER TABLE "PlatformSwitch"
    ADD CONSTRAINT "PlatformSwitch_key_check"
    CHECK ("key" IN ('sms'));

/* 🔴 DEFAULT-DENY, the PlatformOperation shape: revoke explicitly first (under
   ALTER DEFAULT PRIVILEGES a new table may carry grants), then RLS enabled +
   FORCED with NO policy - the tenant role can neither read nor flip a
   platform switch; only the owner connection behind the admin portal can. */
REVOKE ALL ON "PlatformSwitch" FROM chairback_app;
ALTER TABLE "PlatformSwitch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformSwitch" FORCE ROW LEVEL SECURITY;
