-- Plan 2, task 11: phone and emergency-contact (ICE) data are kept for 30 days
-- after the event, then nulled (user decision 2026-10-28, spec 14.18).
--
-- purge_registration_contact_data() nulls registrations.phone, ice_name and
-- ice_phone, and participants.phone for the participants that came from those
-- registrations, for every event whose event_date is 30 or more days ago
-- (Warsaw calendar day). It returns the number of rows it changed, and only
-- touches rows that still hold a value, so a second run returns 0.
--
-- The timing hosts own their copy of participants.phone after closes_at; the
-- operator purges it with backend/scripts/purge-registration-contact.js.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE FUNCTION public.purge_registration_contact_data() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_cutoff date := (now() AT TIME ZONE 'Europe/Warsaw')::date - 30;
  v_regs   integer;
  v_parts  integer;
BEGIN
  UPDATE public.registrations r
     SET phone = NULL, ice_name = NULL, ice_phone = NULL
    FROM public.registration_settings rs
   WHERE rs.event_id = r.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND (r.phone IS NOT NULL OR r.ice_name IS NOT NULL OR r.ice_phone IS NOT NULL);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.participants p
     SET phone = NULL
    FROM public.registrations r
    JOIN public.registration_settings rs ON rs.event_id = r.event_id
   WHERE p.registration_id = r.id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND p.phone IS NOT NULL;
  GET DIAGNOSTICS v_parts = ROW_COUNT;

  RETURN v_regs + v_parts;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_registration_contact_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_registration_contact_data() TO service_role;

-- 03:30 Europe/Warsaw is 01:30 UTC in summer (CEST) and 02:30 UTC in winter
-- (CET); pg_cron runs in UTC, so this fires at 03:30 or 02:30 local time.
SELECT cron.schedule('purge-registration-contact', '30 1 * * *', $$SELECT public.purge_registration_contact_data()$$);
