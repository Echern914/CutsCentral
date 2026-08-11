-- Dashboard appearance preference: "dark" (black & gold, the original) or
-- "light" (white & gold). Per-USER, not per-shop - a theme is about the
-- reader's eyes. Defaulted 'dark' so every existing account keeps exactly the
-- look it has today.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "theme" TEXT NOT NULL DEFAULT 'dark';
