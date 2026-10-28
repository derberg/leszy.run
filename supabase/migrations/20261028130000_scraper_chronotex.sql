-- Raw rows from chronotex.pl (backend/src/scrapers/sources/chronotex.js).
CREATE TABLE IF NOT EXISTS public.scraper_chronotex (
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
  source_id             text NOT NULL,
  source_url            text,
  merged_at             timestamptz,
  created_at            timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scraper_chronotex_source_id_idx
  ON public.scraper_chronotex (source_id);

-- Service role only, like every scraper_* table: the default privileges on
-- public would otherwise let the publishable key read and truncate it.
ALTER TABLE public.scraper_chronotex ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scraper_chronotex FROM anon, authenticated;
