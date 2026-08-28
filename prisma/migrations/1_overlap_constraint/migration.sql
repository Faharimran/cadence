-- The guarantee that two customers can never be sold the same slot.
--
-- Prisma's schema language cannot express an exclusion constraint, so it lives
-- here rather than in schema.prisma. Application-level "is it free?" checks lose
-- this race; Postgres does not.
--
-- btree_gist is required for the `=` operator on a text column inside a GiST
-- exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- '[)' is half-open, so a booking ending at 11:00 and one starting at 11:00 do
-- not overlap — the intuitive reading of back-to-back appointments.
--
-- Filtered on `active` so a cancellation frees the slot immediately without
-- deleting the audit trail.
--
-- The stored interval already includes the service's buffers, so turnover time
-- is enforced by this same constraint rather than by remembering to check it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_resource_no_overlap'
  ) THEN
    ALTER TABLE "BookingResource"
      ADD CONSTRAINT booking_resource_no_overlap
      EXCLUDE USING gist (
        "resourceId" WITH =,
        tstzrange("startsAt", "endsAt", '[)') WITH &&
      ) WHERE (active);
  END IF;
END
$$;
