-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELED', 'RESCHEDULED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "NudgeStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "bookingUrl" TEXT NOT NULL,
    "rewardThreshold" INTEGER NOT NULL DEFAULT 10,
    "rewardLabel" TEXT NOT NULL DEFAULT 'Free Cut',
    "nudgeBufferDays" INTEGER NOT NULL DEFAULT 7,
    "dailySendCap" INTEGER NOT NULL DEFAULT 50,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "webhookSecret" TEXT NOT NULL,
    "acuityWebhookIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcuityConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "acuityAccountId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'api-v1',
    "tokenExpiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcuityConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "acuityClientKey" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "magicToken" TEXT NOT NULL,
    "medianIntervalDays" INTEGER,
    "lastVisitAt" TIMESTAMP(3),
    "nextExpectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "acuityAppointmentId" TEXT NOT NULL,
    "status" "VisitStatus" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "noShow" BOOLEAN NOT NULL DEFAULT false,
    "price" DECIMAL(10,2),
    "serviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PunchLedger" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "visitId" TEXT,
    "punchesEarned" INTEGER NOT NULL DEFAULT 0,
    "punchesRedeemed" INTEGER NOT NULL DEFAULT 0,
    "runningBalance" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PunchLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nudge" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'SMS',
    "status" "NudgeStatus" NOT NULL DEFAULT 'PENDING',
    "body" TEXT,
    "messageSid" TEXT,
    "failedReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "resultedInBookingAt" TIMESTAMP(3),
    "resultedVisitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nudge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_webhookSecret_key" ON "Shop"("webhookSecret");

-- CreateIndex
CREATE INDEX "Shop_ownerId_idx" ON "Shop"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "AcuityConnection_shopId_key" ON "AcuityConnection"("shopId");

-- CreateIndex
CREATE INDEX "AcuityConnection_acuityAccountId_idx" ON "AcuityConnection"("acuityAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_magicToken_key" ON "Client"("magicToken");

-- CreateIndex
CREATE INDEX "Client_shopId_idx" ON "Client"("shopId");

-- CreateIndex
CREATE INDEX "Client_shopId_lastVisitAt_idx" ON "Client"("shopId", "lastVisitAt");

-- CreateIndex
CREATE UNIQUE INDEX "Client_shopId_acuityClientKey_key" ON "Client"("shopId", "acuityClientKey");

-- CreateIndex
CREATE INDEX "Visit_shopId_clientId_scheduledAt_idx" ON "Visit"("shopId", "clientId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Visit_status_endAt_idx" ON "Visit"("status", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_shopId_acuityAppointmentId_key" ON "Visit"("shopId", "acuityAppointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PunchLedger_visitId_key" ON "PunchLedger"("visitId");

-- CreateIndex
CREATE INDEX "PunchLedger_shopId_clientId_idx" ON "PunchLedger"("shopId", "clientId");

-- CreateIndex
CREATE INDEX "Nudge_shopId_clientId_createdAt_idx" ON "Nudge"("shopId", "clientId", "createdAt");

-- CreateIndex
CREATE INDEX "Nudge_status_createdAt_idx" ON "Nudge"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcuityConnection" ADD CONSTRAINT "AcuityConnection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchLedger" ADD CONSTRAINT "PunchLedger_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchLedger" ADD CONSTRAINT "PunchLedger_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchLedger" ADD CONSTRAINT "PunchLedger_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nudge" ADD CONSTRAINT "Nudge_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nudge" ADD CONSTRAINT "Nudge_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
