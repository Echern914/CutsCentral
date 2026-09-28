-- When Acuity first refused ChairBack's login (401/403, or a refused token
-- refresh). null = the login works, which is every existing row. The connection
-- row itself stays; this only lets settings and readiness say "Reconnect
-- Acuity" instead of "Connected". Additive and nullable: no default, no backfill.
ALTER TABLE "AcuityConnection" ADD COLUMN "authFailedAt" TIMESTAMP(3);
