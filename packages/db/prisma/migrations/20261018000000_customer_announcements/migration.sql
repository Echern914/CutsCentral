-- My ChairBack's announcements bell.
--
-- CustomerAccount.announcementsSeenAt - when the customer last opened
-- Announcements. WHY A COLUMN, NOT A TABLE: the bell asks one question - "has
-- anything reached me since I last looked?" - so one timestamp per account
-- answers it, the same on every phone. A per-message read table would record
-- which of a shop's promotions somebody opened, which nothing here needs.
-- Null = never opened, so everything already delivered reads as new once.
ALTER TABLE "CustomerAccount" ADD COLUMN "announcementsSeenAt" TIMESTAMP(3);

-- The bell reads one customer's delivered rows, newest first. BroadcastSend
-- holds a row for every client in every blast's audience, and nothing indexed
-- it by client, so without this every home load would scan all of them.
CREATE INDEX "BroadcastSend_clientId_sentAt_idx" ON "BroadcastSend"("clientId", "sentAt");
