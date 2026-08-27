-- Raw scraper table for motivato.pl (editorial Polish running calendar).
-- Supabase-only: scraper_* tables have no Drizzle schema and no local migration.
-- lat/lng are numeric(9, 6) to match calendar_events — unbounded numeric produces
-- phantom diffs in the publish report.

CREATE TABLE IF NOT EXISTS public.scraper_motivato (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  date                  text NOT NULL,
  location              text,
  distances             text,
  registration_url      text,
  registration_deadline date,
  regulamin_url         text,
  website               text,
  is_kids               boolean DEFAULT false,
  event_types           text[],
  price_from            numeric,
  price_to              numeric,
  lat                   numeric(9, 6),
  lng                   numeric(9, 6),
  source_id             text NOT NULL,
  source_url            text,
  merged_at             timestamptz,
  created_at            timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS scraper_motivato_source_id_idx
  ON public.scraper_motivato (source_id);

-- Raw scraper data is service_role only, like every other scraper_* table.
ALTER TABLE public.scraper_motivato ENABLE ROW LEVEL SECURITY;
