-- biegigorskie.pl, the Polish mountain-running calendar (one table per year).
-- Editorial portal, not a registration host, so it reaches organizer-run mountain,
-- trail and ultra races that the timing platforms never list.

CREATE TABLE IF NOT EXISTS public.scraper_biegigorskie (
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

CREATE UNIQUE INDEX IF NOT EXISTS scraper_biegigorskie_source_id_idx
  ON public.scraper_biegigorskie (source_id);

-- Supabase's default privileges on `public` grant every new table to anon and
-- authenticated, which would leave this one readable and truncatable by anyone
-- holding the publishable key. Both writers use the service role key.
ALTER TABLE public.scraper_biegigorskie ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scraper_biegigorskie FROM anon, authenticated;
