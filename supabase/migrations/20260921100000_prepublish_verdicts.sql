-- What the pre-publish review has already proved about one field of one event.
--
-- A diagnose agent costs about a dollar and its answer used to live in a JSON
-- file under backend/logs. On 2026-09-18 an agent fetched foxter's /mentor page,
-- compared it against a foxter event that does render its distances, and proved
-- that the organizer has published none. That proof was written to a log nobody
-- opens. The next run paid for the same answer, and the operator reviewing the
-- accept queue still saw a blank distances column with no explanation.
--
-- This table is where the answer goes instead. It does two jobs:
--   1. the review step skips a field it has recently settled, so the same
--      question is not bought twice
--   2. the admin calendar list shows the reason next to the blank column, which
--      is the only screen the operator actually reads
--
-- It records what was found. It never changes calendar_events: a field is still
-- locked by a person pressing "brak", because an automatic lock would block the
-- value forever if the organizer published it next week.

CREATE TABLE IF NOT EXISTS public.prepublish_verdicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,
  source_id   text NOT NULL,
  field       text NOT NULL,
  verdict     text NOT NULL CHECK (verdict IN ('absent-at-source', 'code-defect', 'needs-human')),
  summary     text,
  evidence    jsonb,
  event_name  text,
  event_date  date,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  run_id      text
);

-- One current answer per field of an event. A later run overwrites the earlier
-- one, because the newer look at the source page is the better one.
CREATE UNIQUE INDEX IF NOT EXISTS prepublish_verdicts_field_idx
  ON public.prepublish_verdicts (source, source_id, field);

CREATE INDEX IF NOT EXISTS prepublish_verdicts_decided_at_idx
  ON public.prepublish_verdicts (decided_at DESC);

-- Supabase's default privileges on `public` grant every new table to anon and
-- authenticated. The only writer is the review step, which holds the service
-- role key; the admin app reads it through the backend, which holds the same.
ALTER TABLE public.prepublish_verdicts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prepublish_verdicts FROM anon, authenticated;
