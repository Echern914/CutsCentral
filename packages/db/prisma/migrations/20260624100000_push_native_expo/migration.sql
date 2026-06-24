-- Extend PushSubscription to carry BOTH transports in one table:
--   web  = browser/PWA Web Push (existing rows; endpoint + p256dh + auth)
--   expo = native app via Expo's push service (expoPushToken)
-- so the send path treats every device uniformly. Existing rows are all web.

-- New transport discriminator. Existing rows default to 'web'.
CREATE TYPE "PushKind" AS ENUM ('web', 'expo');
ALTER TABLE "PushSubscription" ADD COLUMN "kind" "PushKind" NOT NULL DEFAULT 'web';

-- The native Expo push token (null for web rows). Unique so re-registering the
-- same device upserts instead of duplicating.
ALTER TABLE "PushSubscription" ADD COLUMN "expoPushToken" TEXT;
CREATE UNIQUE INDEX "PushSubscription_expoPushToken_key" ON "PushSubscription"("expoPushToken");

-- The web-push fields are now transport-specific, so they must be nullable
-- (an expo row has no endpoint/keys). Existing web rows keep their values.
ALTER TABLE "PushSubscription" ALTER COLUMN "endpoint" DROP NOT NULL;
ALTER TABLE "PushSubscription" ALTER COLUMN "p256dh" DROP NOT NULL;
ALTER TABLE "PushSubscription" ALTER COLUMN "auth" DROP NOT NULL;
