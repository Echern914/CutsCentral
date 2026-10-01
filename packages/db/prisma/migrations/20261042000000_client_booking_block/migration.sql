-- A shop can block a client from booking online (Client.bookingBlockedAt).
-- Nullable and additive: NULL = not blocked, which is every existing client, so
-- nothing about anyone's booking changes until an owner or manager blocks
-- somebody from that client's page.
ALTER TABLE "Client" ADD COLUMN "bookingBlockedAt" TIMESTAMP(3);
