-- "Remove" on a shop's Recent messages. A sent message used to stay on the
-- list for good, with no way to take it back off. Removing keeps the row (its
-- sends, counts and the month's allowance it used are history) and hides it
-- from the shop's list and from every customer's in-app bell. Nullable and
-- additive: every existing broadcast stays exactly as it was.
ALTER TABLE "Broadcast" ADD COLUMN "removedAt" TIMESTAMP(3);
