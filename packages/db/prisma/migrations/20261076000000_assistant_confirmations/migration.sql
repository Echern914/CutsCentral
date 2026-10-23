-- The booking chat's confirmations. See schema.prisma (AssistantConfirmation).
CREATE TABLE "AssistantConfirmation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "stateKey" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantConfirmation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssistantConfirmation_action_check" CHECK ("action" IN ('book', 'move', 'cancel')),
    CONSTRAINT "AssistantConfirmation_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'superseded'))
);

CREATE INDEX "AssistantConfirmation_shopId_actor_createdAt_idx" ON "AssistantConfirmation"("shopId", "actor", "createdAt");
CREATE INDEX "AssistantConfirmation_expiresAt_idx" ON "AssistantConfirmation"("expiresAt");

ALTER TABLE "AssistantConfirmation" ADD CONSTRAINT "AssistantConfirmation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* Default-deny, like the admin and customer-account tables: revoked from the
   tenant role, RLS forced with no policies. The API uses runAsOwner. */
REVOKE ALL ON "AssistantConfirmation" FROM chairback_app;
ALTER TABLE "AssistantConfirmation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssistantConfirmation" FORCE ROW LEVEL SECURITY;
