-- A team member may now be registered without a phone: the captain gives an adult member's name,
-- birth date, gender and e-mail, and the member fills the rest on /zgoda (memberDetails.js).
-- organizer_edit_registration refused every edit of a row whose phone was null, so the organizer
-- could not correct even a surname of such a member. The phone is now judged like city, club,
-- ICE and nationality: only when the edit changes it (a cleared phone is still refused, a new one
-- must still be a phone number).
--
-- Recreated from its latest body (20261102102000_organizer_panel_concurrency.sql) and changed
-- only where marked. CREATE OR REPLACE keeps every grant; the REVOKE / GRANT restate them.

CREATE OR REPLACE FUNCTION public.organizer_edit_registration(p_registration_id uuid, p_fields jsonb, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  c_allowed constant text[] := ARRAY['firstName', 'lastName', 'birthDate', 'gender', 'phone', 'city', 'club',
                                     'nationality', 'iceName', 'icePhone'];
  c_phone   constant text := '^\+?[0-9][0-9 -]{5,19}$';
  r         public.registrations%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_comp    public.competitions%ROWTYPE;
  v_fields  jsonb := coalesce(p_fields, '{}'::jsonb);
  v_key     text;
  v_mode    text;
  v_today   date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_age     integer;
  v_changed boolean;
  v_first   text;
  v_last    text;
  v_phone   text;
  v_city    text;
  v_club    text;
  v_icen    text;
  v_icep    text;
  v_nat     text;
  v_birth   date;
  v_gender  text;
  v_label   text;
  v_kids    uuid;
BEGIN
  IF jsonb_typeof(v_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_field';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
    IF v_key <> ALL (c_allowed) OR jsonb_typeof(v_fields->v_key) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_field';
    END IF;
  END LOOP;

  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF r.status NOT IN ('pending_payment', 'confirmed') THEN
    RAISE EXCEPTION 'not_live';
  END IF;
  IF v_rs.closes_at IS NULL OR clock_timestamp() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'edits_closed';
  END IF;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = r.category_id;

  -- The person after the edits: a key that is absent keeps the stored value.
  v_first  := CASE WHEN v_fields ? 'firstName' THEN nullif(btrim(v_fields->>'firstName'), '') ELSE r.first_name END;
  v_last   := CASE WHEN v_fields ? 'lastName' THEN nullif(btrim(v_fields->>'lastName'), '') ELSE r.last_name END;
  v_phone  := CASE WHEN v_fields ? 'phone' THEN nullif(btrim(v_fields->>'phone'), '') ELSE r.phone END;
  v_city   := CASE WHEN v_fields ? 'city' THEN nullif(btrim(v_fields->>'city'), '') ELSE r.city END;
  v_club   := CASE WHEN v_fields ? 'club' THEN nullif(btrim(v_fields->>'club'), '') ELSE r.club END;
  v_icen   := CASE WHEN v_fields ? 'iceName' THEN nullif(btrim(v_fields->>'iceName'), '') ELSE r.ice_name END;
  v_icep   := CASE WHEN v_fields ? 'icePhone' THEN nullif(btrim(v_fields->>'icePhone'), '') ELSE r.ice_phone END;
  v_nat    := CASE WHEN v_fields ? 'nationality' THEN upper(nullif(btrim(v_fields->>'nationality'), '')) ELSE r.nationality END;
  v_gender := CASE WHEN v_fields ? 'gender' THEN v_fields->>'gender' ELSE r.gender END;
  BEGIN
    v_birth := CASE WHEN v_fields ? 'birthDate' THEN (v_fields->>'birthDate')::date ELSE r.birth_date END;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'edit_invalid';
  END;

  IF v_first IS NULL OR v_last IS NULL OR char_length(v_first) > 100 OR char_length(v_last) > 100
     -- Changed here: the phone only when the edit changes it (a member may still owe it).
     OR (v_phone IS DISTINCT FROM r.phone AND (v_phone IS NULL OR v_phone !~ c_phone))
     OR v_gender IS NULL OR v_gender NOT IN ('M', 'K')
     OR v_birth IS NULL OR v_birth < DATE '1900-01-01' OR v_birth > v_today
     OR char_length(v_city) > 200 OR char_length(v_club) > 200 OR char_length(v_icen) > 200
     OR (v_icep IS NOT NULL AND v_icep !~ c_phone)
     OR (v_nat IS NOT NULL AND NOT public.registration_country_ok(v_nat)) THEN
    RAISE EXCEPTION 'edit_invalid';
  END IF;
  -- The event's form switches, only for values that change (a stored value stays valid).
  v_mode := coalesce(v_rs.form_fields->>'city', 'optional');
  IF v_city IS DISTINCT FROM r.city AND ((v_mode = 'off' AND v_city IS NOT NULL) OR (v_mode = 'required' AND v_city IS NULL)) THEN
    RAISE EXCEPTION 'edit_invalid';
  END IF;
  v_mode := coalesce(v_rs.form_fields->>'club', 'optional');
  IF v_club IS DISTINCT FROM r.club AND ((v_mode = 'off' AND v_club IS NOT NULL) OR (v_mode = 'required' AND v_club IS NULL)) THEN
    RAISE EXCEPTION 'edit_invalid';
  END IF;
  v_mode := coalesce(v_rs.form_fields->>'ice', 'optional');
  IF (v_icen IS DISTINCT FROM r.ice_name OR v_icep IS DISTINCT FROM r.ice_phone)
     AND ((v_mode = 'off' AND (v_icen IS NOT NULL OR v_icep IS NOT NULL))
          OR (v_mode = 'required' AND (v_icen IS NULL OR v_icep IS NULL))) THEN
    RAISE EXCEPTION 'edit_invalid';
  END IF;
  v_mode := coalesce(v_rs.form_fields->>'nationality', 'off');
  IF v_nat IS DISTINCT FROM r.nationality AND ((v_mode = 'off' AND v_nat IS NOT NULL) OR (v_mode = 'required' AND v_nat IS NULL)) THEN
    RAISE EXCEPTION 'edit_invalid';
  END IF;

  v_label := r.age_group_label;
  v_kids := r.kids_group_id;
  IF v_birth IS DISTINCT FROM r.birth_date OR v_gender IS DISTINCT FROM r.gender THEN
    v_age := public.registration_age_on(v_birth, coalesce(v_rs.event_date, v_today), v_rs.age_reckoning);
    IF (v_comp.min_age IS NOT NULL AND v_age < v_comp.min_age) OR (v_comp.max_age IS NOT NULL AND v_age > v_comp.max_age) THEN
      RAISE EXCEPTION 'ineligible';
    END IF;
    -- A child's entry has no e-mail and a guardian; an adult's has an e-mail. The role follows them.
    -- A minor is under 18 on race day (Warsaw), as everywhere in registration, never today.
    IF (public.registration_age_on(v_birth, coalesce(v_rs.event_date, v_today), 'race_day') < 18) <> (r.email IS NULL) THEN
      RAISE EXCEPTION 'role_change';
    END IF;
    SELECT coalesce((SELECT g.label FROM public.age_groups g
                      WHERE g.category_id = r.category_id AND g.gender = v_gender
                        AND v_age >= g.min_age AND (g.max_age IS NULL OR v_age <= g.max_age)
                      ORDER BY g.min_age, g.id LIMIT 1),
                    v_gender || ' open')
      INTO v_label;
    IF v_comp.is_kids THEN
      SELECT k.id INTO v_kids FROM public.kids_groups k
       WHERE k.category_id = r.category_id
         AND extract(year FROM v_birth)::integer BETWEEN k.birth_year_from AND k.birth_year_to
         AND (k.gender IS NULL OR k.gender = v_gender)
       ORDER BY k.birth_year_from, k.id LIMIT 1;
    END IF;
  END IF;

  v_changed := (v_first, v_last, v_phone, v_city, v_club, v_icen, v_icep, v_nat, v_birth, v_gender)
               IS DISTINCT FROM
               (r.first_name, r.last_name, r.phone, r.city, r.club, r.ice_name, r.ice_phone, r.nationality,
                r.birth_date, r.gender);
  IF NOT v_changed THEN
    RETURN jsonb_build_object('changed', false, 'ageGroupLabel', r.age_group_label, 'kidsGroupId', r.kids_group_id);
  END IF;

  BEGIN
    UPDATE public.registrations
       SET first_name = v_first, last_name = v_last, phone = v_phone, city = v_city, club = v_club,
           ice_name = v_icen, ice_phone = v_icep, nationality = v_nat, birth_date = v_birth, gender = v_gender,
           age_group_label = v_label, kids_group_id = v_kids
     WHERE id = r.id;
  EXCEPTION WHEN unique_violation THEN
    -- A child's live entry is unique per event by name and birth date.
    RAISE EXCEPTION 'duplicate';
  END;
  IF r.participant_id IS NOT NULL THEN
    UPDATE public.participants
       SET first_name = v_first, last_name = v_last, gender = v_gender, birth_date = v_birth,
           club = v_club, phone = v_phone, updated_at = now()
     WHERE id = r.participant_id;
  END IF;
  RETURN jsonb_build_object('changed', true, 'ageGroupLabel', v_label, 'kidsGroupId', v_kids);
END $$;
REVOKE EXECUTE ON FUNCTION public.organizer_edit_registration(uuid, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organizer_edit_registration(uuid, jsonb, uuid) TO service_role;
