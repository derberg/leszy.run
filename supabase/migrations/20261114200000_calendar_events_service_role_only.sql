-- calendar_events becomes service-role only.
--
-- MERGE ONLY AFTER the public app stops reading it (the pull request "Public app: stop
-- reading calendar_events with the publishable key") is deployed on Vercel AND its edge
-- function get-user-submissions is live. Before that, the landing teaser, the POLECAMY
-- banner's chips, "W okolicy tego weekendu", /listy, in-app navigation to a /kalendarz
-- race and the submissions on /u/<username> come up empty for every visitor.
--
-- Why: the table was granted ALL to anon and authenticated with a `public_read` policy
-- USING (true), so anyone holding the publishable key (every browser has it) could page
-- through the whole race calendar over PostgREST, pending and rejected rows included,
-- with submitted_by, locked_fields and every other column. 20261030020000_anon_lockdown
-- took away the writes; this takes away the read. The public pages now read build-time
-- files (/kalendarz/events.json and the pre-rendered race pages) and edge functions on
-- the service role.
--
-- Who still reads it, all unaffected: the backend, scheduler, enricher and the publish
-- scripts (service-role key); every edge function (service role); and the SECURITY
-- DEFINER functions owned by postgres that touch it (registration_write_public_rows via
-- publish_registration_event / publish_registration_changes, registration_auto_follow,
-- notify_calendar_event_changes). No view selects from it.
--
-- REVOKE ALL rather than SELECT alone, as for the scraper_* tables: the remaining
-- REFERENCES and TRIGGER from the original GRANT ALL serve no client either.

REVOKE ALL ON TABLE public.calendar_events FROM anon, authenticated;

-- With no client grant the policy decides nothing; drop it so nobody reads it as "public".
DROP POLICY IF EXISTS "public_read" ON public.calendar_events;

-- RLS stays on: a future GRANT to a client role then still needs a policy of its own.
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
