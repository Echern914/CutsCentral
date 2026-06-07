-- Manual client management: private notes + source (acuity vs manually added).
ALTER TABLE "Client" ADD COLUMN "notes" TEXT;
ALTER TABLE "Client" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'acuity';
