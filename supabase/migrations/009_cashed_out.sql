-- 009: a slip the operator CASHED OUT on the bookmaker before it was decided (2026-10-04: #22 of S-B44EC5
-- paid ₦487.81 with 4 games unplayed). Its own status so it's never re-settled as won/lost by results,
-- counts as money back, and drops out of the survival maths.
ALTER TABLE pedla_placements DROP CONSTRAINT IF EXISTS pedla_placements_status_check;
ALTER TABLE pedla_placements ADD CONSTRAINT pedla_placements_status_check
  CHECK (status IN ('pending','placing','submitting','verify','placed','failed','simulated','skipped','won','lost','void','cashed_out'));
