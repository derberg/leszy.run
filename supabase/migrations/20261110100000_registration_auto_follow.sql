-- Auto-follow on registration: a confirmed entry stars the event for the people on it.
--
-- When a registration becomes confirmed (inserted confirmed, e.g. a free entry or a transfer's new
-- row, or a paid order's entry moving from pending_payment), every distinct non-null one of
-- profile_id, registered_by_profile_id and guardian_profile_id gets an event_favorites row for the
-- event's calendar row, so the race shows in "Obserwowane" and its notifications reach them.
--
--   * Only the transition fires it. A person who unstars the race afterwards stays unstarred: a
--     later UPDATE of a row that was already confirmed does nothing.
--   * The calendar row is the one registration_write_public_rows maintains (source 'leszyrun',
--     source_id = event_id::text, the oldest when several exist), and only when it is 'active' or
--     'cancelled', the same statuses toggle-favorite accepts. An unlisted („Tylko przez link”)
--     event has no calendar row, so nothing is starred.
--   * ON CONFLICT DO NOTHING on event_favorites' primary key (user_id, event_id).
--   * A failure here never rolls back the registration (and with it a payment confirmation): it
--     is caught and reported as a WARNING.
--
-- Followed by a one-time backfill for registrations already confirmed.

CREATE OR REPLACE FUNCTION public.registration_auto_follow()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_cal uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'confirmed'
     OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'confirmed') THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT ce.id INTO v_cal
      FROM public.calendar_events ce
     WHERE ce.source = 'leszyrun' AND ce.source_id = NEW.event_id::text
       AND ce.status IN ('active', 'cancelled')
     ORDER BY ce.created_at, ce.id
     LIMIT 1;
    IF v_cal IS NULL THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.event_favorites (user_id, event_id)
    SELECT DISTINCT p.id, v_cal
      FROM unnest(ARRAY[NEW.profile_id, NEW.registered_by_profile_id, NEW.guardian_profile_id]) AS p(id)
     WHERE p.id IS NOT NULL
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'registration_auto_follow: registration %: % (%)', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_auto_follow() FROM public, anon, authenticated;

CREATE TRIGGER registration_auto_follow
  AFTER INSERT OR UPDATE OF status ON public.registrations
  FOR EACH ROW
  WHEN (NEW.status = 'confirmed')
  EXECUTE FUNCTION public.registration_auto_follow();

-- ---------------------------------------------------------------- one-time backfill

INSERT INTO public.event_favorites (user_id, event_id)
SELECT DISTINCT p.id, cal.id
  FROM public.registrations r
  CROSS JOIN LATERAL unnest(ARRAY[r.profile_id, r.registered_by_profile_id, r.guardian_profile_id]) AS p(id)
  CROSS JOIN LATERAL (
    SELECT ce.id
      FROM public.calendar_events ce
     WHERE ce.source = 'leszyrun' AND ce.source_id = r.event_id::text
       AND ce.status IN ('active', 'cancelled')
     ORDER BY ce.created_at, ce.id
     LIMIT 1
  ) AS cal
 WHERE r.status = 'confirmed'
   AND p.id IS NOT NULL
ON CONFLICT DO NOTHING;
