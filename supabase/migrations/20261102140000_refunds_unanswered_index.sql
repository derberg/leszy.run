-- Plan 6 final review M2. refunds_unanswered_idx (20261030125000) was built for stalled_refunds
-- when that function looked at automatic refunds only (`WHERE kind = 'automatic' …`). Plan 6
-- recreated stalled_refunds without the kind filter (20261102100000, D6-22), so the partial index
-- no longer matches its query and the planner scans refunds every 15 minutes. The same index
-- without the kind predicate matches the query's own conditions again.
DROP INDEX IF EXISTS public.refunds_unanswered_idx;
CREATE INDEX refunds_unanswered_idx ON public.refunds (created_at)
  WHERE dpay_status NOT IN ('accepted', 'rejected') AND next_retry_at IS NULL;
