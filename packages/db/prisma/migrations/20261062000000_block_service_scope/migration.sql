/* BLOCK OFF TIME FOR SOME SERVICES, NOT THE WHOLE CHAIR.

   A barber can block "Shape-ups and Kids' cuts, 3-6 PM" and keep ordinary
   Haircuts bookable over the same hours. A block row now says which services
   it stops:

   1. "serviceIds" TEXT[] NOT NULL DEFAULT '{}'. Empty = EVERY service, which
      is what every existing row means and keeps meaning (the barber is not
      there). A list = only those services are refused over the span. Same
      convention as ServiceAddOn.serviceIds: a stale id (a deleted service)
      is inert, and an empty list fails to blocking MORE, never less.
   2. A CHECK that no id is NULL or blank, so the array never carries a value
      that could match nothing by accident.

   Additive. ADD COLUMN with a constant default is a catalog-only change in
   Postgres 11+ (no table rewrite, no trigger fired); existing rows read '{}'
   = all services, exactly today's behavior. The table's existing grants and
   tenant policy cover the new column. Reversible by dropping the constraint
   and the column. */

ALTER TABLE "AvailabilityException"
  ADD COLUMN "serviceIds" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "AvailabilityException"
  ADD CONSTRAINT "AvailabilityException_serviceIds_check"
  CHECK (array_position("serviceIds", NULL) IS NULL AND array_position("serviceIds", '') IS NULL);
