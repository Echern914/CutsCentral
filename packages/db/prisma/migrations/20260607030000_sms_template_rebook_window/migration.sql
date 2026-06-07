-- Custom SMS template per shop + rebooking countdown window.
ALTER TABLE "Shop" ADD COLUMN "smsTemplate" TEXT;
ALTER TABLE "Shop" ADD COLUMN "rebookWindowDays" INTEGER NOT NULL DEFAULT 14;
