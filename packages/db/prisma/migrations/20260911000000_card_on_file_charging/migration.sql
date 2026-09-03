-- Card on file, part 2: charging. A kept card moves through one more state,
-- `charging`, which is the compare-and-swap that makes two simultaneous no-show
-- marks charge exactly once (saved -> charging succeeds for one caller). The
-- status vocabulary is CHECK-pinned, so the vocabulary change is a migration.
ALTER TABLE "CardOnFile" DROP CONSTRAINT IF EXISTS "CardOnFile_status_check";
ALTER TABLE "CardOnFile" ADD CONSTRAINT "CardOnFile_status_check"
  CHECK ("status" IN ('pending', 'saved', 'charging', 'released', 'charged', 'failed'));
