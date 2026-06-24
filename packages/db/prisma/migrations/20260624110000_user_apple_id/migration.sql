-- Sign in with Apple (native iOS): store Apple's stable user id ("sub") so a
-- barber who signs in with Apple is matched to their User across launches.
-- Nullable + unique, mirroring googleId. Existing users are unaffected.
ALTER TABLE "User" ADD COLUMN "appleId" TEXT;
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");
