-- The shop's Google "write a review" link.
--
-- One-way on purpose. Google's Places API returns at most 5 reviews and its
-- terms forbid storing or re-displaying them, so pulling Google reviews in to
-- show as testimonials is not something we can legally build. Pushing happy
-- reviewers OUT to the Google listing is both allowed and the more valuable
-- direction: the listing is where "barber near me" gets decided.
ALTER TABLE "Shop" ADD COLUMN "googleReviewUrl" TEXT;
