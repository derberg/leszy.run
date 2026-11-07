-- PZLA course certification (atest) for calendar races.
--
-- atest_register: the PZLA register of certified courses, read from
-- http://www.taddziek.pl/rejestr_tras_atestowanych.html by
-- backend/scripts/run-atest.js. Pipeline data like the scraper_* tables, so
-- service_role only (RLS on, every client privilege revoked).
CREATE TABLE IF NOT EXISTS public.atest_register (
  row_key       text PRIMARY KEY,
  distance_km   numeric NOT NULL,
  town          text NOT NULL,
  name          text NOT NULL,
  certified_on  date,
  status        text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.atest_register ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atest_register FROM anon, authenticated;

-- scraper_all.atest_claim: what the regulamin says, written by
-- run-enrich-from-regulamin.js: { "certified": true|false|null, "distances_km": [..] }.
-- scraper_all.atest: what run-atest.js decided, the register backing it:
-- [{ "km": 21.0975, "certified_on": "2025-04-06", "source": "both"|"register" }].
ALTER TABLE public.scraper_all ADD COLUMN IF NOT EXISTS atest_claim jsonb;
ALTER TABLE public.scraper_all ADD COLUMN IF NOT EXISTS atest jsonb;

-- calendar_events.atest: the same array, published by run-publish.js and shown on
-- the race page as "Atest PZLA" on the certified distances. Public by nature:
-- the register itself is a public page.
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS atest jsonb;
