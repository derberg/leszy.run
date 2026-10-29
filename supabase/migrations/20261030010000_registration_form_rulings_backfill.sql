-- Plan 2, follow-up to 20261030000000 (rulings P2-R31…R33), review U1 M1/M2.
--
-- M1: 20261030000000 changed only the form_fields default, so an event created
--   before it kept a `phone` key and had no `nationality` key. validateSection
--   always sends `nationality` and never `phone`, so the first form save on
--   such a published event staged a „Pola formularza” change with identical
--   labels on both sides. The stored values are brought to the new shape here:
--   `phone` removed, `nationality` added as 'off' where it is missing (a value
--   already set is kept).
-- M2: the image-acceptance backfill ran inline in 20261030000000, where no
--   test could reach it (`supabase db reset` runs it on an empty table). The
--   same statement now lives in registration_backfill_form_rulings(), which
--   this migration runs once and tests/registration/draft.test.js runs on an
--   event made to look like one from before the rulings. Both steps are
--   idempotent: a second run changes nothing.

CREATE OR REPLACE FUNCTION public.registration_backfill_form_rulings() RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_images integer;
  v_forms  integer;
BEGIN
  -- Events without the image acceptance. sort_order 1: after regulamin (0),
  -- level with data_info, before every custom consent (2…).
  INSERT INTO public.event_consents (event_id, kind, text, sort_order)
  SELECT rs.event_id, 'image',
         'Akceptuję, że mój wizerunek utrwalony podczas zawodów (zdjęcia, wideo) może zostać opublikowany w relacjach i wynikach zawodów, zgodnie z regulaminem.',
         1
    FROM public.registration_settings rs
   WHERE NOT EXISTS (SELECT 1 FROM public.event_consents ec WHERE ec.event_id = rs.event_id AND ec.kind = 'image');
  GET DIAGNOSTICS v_images = ROW_COUNT;

  UPDATE public.registration_settings
     SET form_fields = (form_fields - 'phone')
                       || jsonb_build_object('nationality', coalesce(form_fields -> 'nationality', '"off"'::jsonb))
   WHERE form_fields ? 'phone' OR NOT form_fields ? 'nationality';
  GET DIAGNOSTICS v_forms = ROW_COUNT;

  RETURN jsonb_build_object('images', v_images, 'formFields', v_forms);
END;
$$;

REVOKE ALL ON FUNCTION public.registration_backfill_form_rulings() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_backfill_form_rulings() TO service_role;

SELECT public.registration_backfill_form_rulings();
