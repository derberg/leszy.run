-- Plan 2, rulings P2-R31…R33 on the registration form (wizard step „Formularz”).
--
-- P2-R31 nationality: registrations.nationality holds an ISO 3166-1 alpha-2
--   code (validated against the list in register-free, _shared/registration/
--   countries.js; the CHECK here keeps the shape). It stays on the
--   registration: participants and the timing hosts never get it. The new
--   form_fields key `nationality` defaults to 'off'.
-- P2-R32 phone: always required. The `phone` key leaves the form_fields
--   default; a stored one is ignored by validatePerson and dropped by
--   validateSection. Nothing here rewrites stored values.
-- P2-R33 image: the publication of a runner's image is a term of the
--   regulamin the runner accepts, not a consent (a mandatory consent is not
--   freely given, Art. 7(4) GDPR). It is a system acceptance like regulamin
--   and data_info: kind 'image', created with every event, outside the
--   organizer's list (apply_registration_section only ever lists, rewrites
--   and deletes kind 'custom'). register_free already requires every event
--   consent. Events created before this migration get it here.

-- ---------------------------------------------------------------- nationality

ALTER TABLE public.registrations
  ADD COLUMN nationality text,
  ADD CONSTRAINT registrations_nationality_check CHECK (nationality ~ '^[A-Z]{2}$');

ALTER TABLE public.registration_settings
  ALTER COLUMN form_fields SET DEFAULT '{"city":"optional","club":"optional","ice":"optional","nationality":"off"}'::jsonb;

-- ---------------------------------------------------------------- image acceptance

ALTER TABLE public.event_consents
  DROP CONSTRAINT event_consents_kind_check,
  ADD CONSTRAINT event_consents_kind_check CHECK (kind IN ('regulamin', 'data_info', 'image', 'custom'));
ALTER TABLE public.consent_acceptances
  DROP CONSTRAINT consent_acceptances_consent_kind_check,
  ADD CONSTRAINT consent_acceptances_consent_kind_check
    CHECK (consent_kind IN ('regulamin', 'data_info', 'image', 'custom', 'service_regulamin'));

-- Events created before P2-R33. sort_order 1: after regulamin (0), level with
-- data_info, before every custom consent (2…); the read models order by kind
-- first and sort_order second, so it lands right after data_info.
INSERT INTO public.event_consents (event_id, kind, text, sort_order)
SELECT rs.event_id, 'image',
       'Akceptuję, że mój wizerunek utrwalony podczas zawodów (zdjęcia, wideo) może zostać opublikowany w relacjach i wynikach zawodów, zgodnie z regulaminem.',
       1
  FROM public.registration_settings rs
 WHERE NOT EXISTS (SELECT 1 FROM public.event_consents ec WHERE ec.event_id = rs.event_id AND ec.kind = 'image');

-- One of each system acceptance per event.
CREATE UNIQUE INDEX event_consents_event_system_kind_key
  ON public.event_consents (event_id, kind) WHERE kind <> 'custom';

-- ---------------------------------------------------------------- create

-- Replaced from 20261029140000 with the image acceptance added; unchanged otherwise.
CREATE OR REPLACE FUNCTION public.create_registration_event(p_club_id uuid, p_name text, p_actor uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_name  text := btrim(coalesce(p_name, ''));
  v_event uuid := gen_random_uuid();
  v_base  text;
  v_slug  text;
  v_n     integer := 1;
BEGIN
  IF v_name = '' OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  -- The edge function checked this already; the RPC does not trust its caller.
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role IN ('owner', 'admin'))
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_base := public.registration_slugify(v_name);
  IF char_length(v_base) < 3 THEN
    v_base := CASE WHEN v_base = '' THEN 'zawody' ELSE 'zawody-' || v_base END;
  END IF;

  INSERT INTO public.events (id, name, slug, visibility, club_id, rssi_threshold, min_finish_seconds)
  VALUES (v_event, 'Szkic', 'szkic-' || v_event, 'private', p_club_id, -9000, 300);

  -- First free of base, base-2, base-3 … against both slug namespaces. Two
  -- creates can pick the same candidate; the loser's insert waits on the unique
  -- index, fails once the winner commits, and moves to the next suffix.
  LOOP
    v_slug := CASE WHEN v_n = 1 THEN v_base
                   ELSE rtrim(left(v_base, 80 - char_length('-' || v_n)), '-') || '-' || v_n END;
    IF NOT EXISTS (SELECT 1 FROM public.registration_settings rs WHERE rs.slug = v_slug)
       AND NOT EXISTS (SELECT 1 FROM public.events e WHERE e.slug = v_slug) THEN
      BEGIN
        INSERT INTO public.registration_settings (event_id, club_id, name, slug)
        VALUES (v_event, p_club_id, v_name, v_slug);
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END IF;
    v_n := v_n + 1;
    IF v_n > 1000 THEN
      RAISE EXCEPTION 'slug_exhausted';
    END IF;
  END LOOP;

  INSERT INTO public.event_consents (event_id, kind, text, sort_order) VALUES
    (v_event, 'regulamin', 'Akceptuję regulamin zawodów.', 0),
    (v_event, 'data_info', 'Znam informację o danych osobowych.', 1),
    (v_event, 'image', 'Akceptuję, że mój wizerunek utrwalony podczas zawodów (zdjęcia, wideo) może zostać opublikowany w relacjach i wynikach zawodów, zgodnie z regulaminem.', 1);

  RETURN v_event;
END $$;
REVOKE EXECUTE ON FUNCTION public.create_registration_event(uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_registration_event(uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------- register_free

-- Replaced from 20261029180000: it stores the person's nationality (p_people[].nationality,
-- null when the event does not ask). Unchanged otherwise; the participants row never gets it.
CREATE OR REPLACE FUNCTION public.register_free(p_category_id uuid, p_people jsonb, p_profile_id uuid, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_comp    public.competitions%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_person  jsonb;
  v_email   text;
  v_reg     uuid;
  v_part    uuid;
  v_out     jsonb := '[]'::jsonb;
  v_ip      inet;
  v_ua      text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_sent    uuid[];
  v_have    uuid[];
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = v_comp.event_id FOR SHARE;
  IF NOT FOUND OR v_rs.state = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_rs.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'published' OR v_comp.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed';
  END IF;
  IF v_rs.pricing_mode <> 'free' THEN
    RAISE EXCEPTION 'not_free';
  END IF;
  IF v_rs.opens_at IS NULL OR now() < v_rs.opens_at THEN
    RAISE EXCEPTION 'not_open';
  END IF;
  IF v_rs.closes_at IS NULL OR now() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  -- The person accepted exactly the consents the form showed; a list that no
  -- longer matches the event's (changed meanwhile) is refused, not guessed.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id;
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  FOR v_person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    v_email := lower(btrim(v_person->>'email'));
    BEGIN
      INSERT INTO public.registrations (
        event_id, category_id, status, profile_id, first_name, last_name, birth_date, gender, email,
        phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id, consent_state,
        list_price, price)
      VALUES (
        v_rs.event_id, p_category_id, 'confirmed',
        -- The account is this person's only when its address is theirs.
        (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email),
        v_person->>'firstName', v_person->>'lastName', (v_person->>'birthDate')::date, v_person->>'gender',
        v_email, v_person->>'phone', v_person->>'city', v_person->>'club', v_person->>'iceName',
        v_person->>'icePhone', nullif(v_person->>'nationality', ''), v_person->>'ageGroupLabel', nullif(v_person->>'kidsGroupId', '')::uuid,
        'accepted', 0, 0)
      RETURNING id INTO v_reg;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate';
    END;

    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, p_profile_id, 'self',
           CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
      FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', p_profile_id, 'self', NULL, v_ip, v_ua;

    INSERT INTO public.participants (
      event_id, category_id, first_name, last_name, email, gender, birth_date, club, phone,
      registration_id, updated_at)
    VALUES (
      v_rs.event_id, p_category_id, v_person->>'firstName', v_person->>'lastName', v_email,
      v_person->>'gender', (v_person->>'birthDate')::date, v_person->>'club', v_person->>'phone',
      v_reg, now())
    RETURNING id INTO v_part;

    UPDATE public.registrations SET participant_id = v_part WHERE id = v_reg;
    v_out := v_out || jsonb_build_object('id', v_reg, 'participantId', v_part, 'email', v_email);
  END LOOP;

  IF public.claim_competition_slots(p_category_id, jsonb_array_length(p_people)) IS NULL THEN
    RAISE EXCEPTION 'full';
  END IF;

  RETURN jsonb_build_object('registrations', v_out);
END $$;
REVOKE EXECUTE ON FUNCTION public.register_free(uuid, jsonb, uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_free(uuid, jsonb, uuid, jsonb) TO service_role;
