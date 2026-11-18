-- Raw rows from etiming.pl (backend/src/scrapers/sources/etiming.js).
CREATE TABLE IF NOT EXISTS public.scraper_etiming (
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
CREATE UNIQUE INDEX IF NOT EXISTS scraper_etiming_source_id_idx
  ON public.scraper_etiming (source_id);

-- Service role only, like every scraper_* table: the default privileges on
-- public would otherwise let the publishable key read and truncate it.
ALTER TABLE public.scraper_etiming ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scraper_etiming FROM anon, authenticated;
