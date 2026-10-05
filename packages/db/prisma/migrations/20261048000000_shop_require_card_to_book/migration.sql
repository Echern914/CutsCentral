-- Card-on-file shops: is a client who does not save a card still booked?
--
-- OFF (the default, and so every card shop on deploy): pressing Confirm books
-- the client, and the card step that follows is optional. Before this, the
-- time was held for ten minutes and silently released if no card was saved,
-- so clients who left the card step believed they were booked while someone
-- else took their time. ON keeps that hold for a shop that wants
-- card-or-nothing.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "requireCardToBook" BOOLEAN NOT NULL DEFAULT false;
