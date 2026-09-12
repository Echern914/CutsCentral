-- 🔴 A RECIPIENT ROW MAY NOT PAIR ONE SHOP'S BLAST WITH ANOTHER SHOP'S CLIENT.
--
-- Found by packages/db/src/broadcastRls.test.ts, which tried it. RLS was not
-- enough on its own: the policy asks "is this row's shopId mine?", and a row
-- stamped with MY shopId but carrying YOUR clientId answers yes. The
-- single-column foreign key then only checks that the client exists somewhere.
--
-- Nothing in the application can currently produce such a row - the freeze
-- reads clients scoped to the broadcast's own shop, and the worker would find
-- no matching client and skip it rather than mail anybody. But "no code path
-- does this today" is a fact about today, and the row this is about is one
-- that decides who receives a shop's marketing. The composite foreign key
-- turns it into something the database cannot store.
--
-- Expressed in SQL rather than in schema.prisma because modelling it there
-- would put `shopId` in two relations at once and complicate every generated
-- type for a constraint nothing needs to see - same reasoning as the
-- hand-written Shop_handle_key_idx.

-- The referenced pair must be unique for a composite FK to point at it. `id`
-- is already the primary key, so this adds no new restriction on Client - it
-- exists purely to be the target below.
ALTER TABLE "Client" ADD CONSTRAINT "Client_id_shopId_key" UNIQUE ("id", "shopId");

ALTER TABLE "BroadcastSend" ADD CONSTRAINT "BroadcastSend_client_same_shop_fkey"
  FOREIGN KEY ("clientId", "shopId") REFERENCES "Client"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;
