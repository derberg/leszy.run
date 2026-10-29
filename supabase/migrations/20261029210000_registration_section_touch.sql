-- Race registration, plan 2 task 8b: every draft section save moves
-- registration_settings.updated_at. Sections that only write child tables
-- (categories: age and kids groups; form: custom consents) left the settings
-- row untouched, so the wizard's „ZAPISANO AUTOMATYCZNIE hh:mm” read after a
-- reload showed an older time, and publish's p_expected_updated_at check did
-- not see those saves. save_registration_section is replaced unchanged except
-- for the final touch; trg_registration_settings_updated_at sets the time.

CREATE OR REPLACE FUNCTION public.save_registration_section(p_event_id uuid, p_section text, p_value jsonb) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_state  text;
  v_result jsonb;
BEGIN
  -- Row lock: saves of one event run one after another, so two sections saved
  -- at the same moment never interleave.
  SELECT rs.state INTO v_state FROM public.registration_settings rs WHERE rs.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_state <> 'draft' THEN
    RAISE EXCEPTION 'not_draft';
  END IF;
  v_result := public.apply_registration_section(p_event_id, p_section, p_value, true);
  -- The touch trigger stamps updated_at = now(), whatever the section wrote.
  UPDATE public.registration_settings SET updated_at = now() WHERE event_id = p_event_id;
  RETURN v_result || jsonb_build_object('savedAt', now());
END $$;
REVOKE EXECUTE ON FUNCTION public.save_registration_section(uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_registration_section(uuid, text, jsonb) TO service_role;
