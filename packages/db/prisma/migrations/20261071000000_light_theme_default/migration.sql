-- LIGHT IS THE MAIN LOOK (Eric, 2026-10-17: "switch from dark mode being
-- secondary ... light the main color scheme, throughout the landing page and
-- website"). New accounts start light.
ALTER TABLE "User" ALTER COLUMN "theme" SET DEFAULT 'light';

-- Existing accounts move to light too. "dark" was the default every account
-- got without choosing, so it cannot tell a choice from a default; anyone who
-- prefers dark switches back in one tap (Account -> Appearance).
UPDATE "User" SET "theme" = 'light' WHERE "theme" = 'dark';
