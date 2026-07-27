-- Per-service TIME-OF-DAY price/duration windows (Drick: "select hours in which
-- appointment duration varies ... slots would be shorter within a specific
-- service", plus the offered-not-built "any slot after 8pm = $65" pricing rule).
-- A JSON array of {s,e,price?,durationMin?} in shop-local minutes-of-day,
-- layered on top of the per-weekday overrides. Additive only (rollback-safe);
-- default [] keeps every existing service byte-for-byte unchanged.
ALTER TABLE "Service" ADD COLUMN "timeOverrides" JSONB NOT NULL DEFAULT '[]';
