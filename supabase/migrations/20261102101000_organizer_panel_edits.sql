-- Plan 6, task 2b: the organizer's non-money edits.
--
--   extend_order_window(order, until, actor) → the new expires_at
--       „Przedłuż termin wpłaty”. One guarded UPDATE: a pending order whose window is still open,
--       moved later, to at most min(now + 14 days, closes_at) (ruling 2: never past closes_at, so
--       an order already at closes_at cannot be extended). It holds no slot and leaves taken alone
--       (P3-R15); reminder_sent_at is cleared so the new window gets its reminder. Refusals:
--       'expired' (not pending, or its window already ended: §14.9), 'invalid_until'.
--   organizer_edit_registration(registration, fields, actor) → { changed, ageGroupLabel, kidsGroupId }
--       „Edytuj dane”, ruling 7. Allow-list firstName, lastName, birthDate, gender, phone, city,
--       club, nationality, iceName, icePhone ('invalid_field' for anything else, the e-mail
--       included). The edge function runs validatePerson first and words the messages; these
--       checks are the backstop ('edit_invalid'). The phone cannot be blanked (P2-R32). A birth
--       date or gender change re-derives age_group_label and kids_group_id here, the one
--       authority, and must stay inside the competition's ages ('ineligible') without turning an
--       adult's entry into a child's or back ('role_change': the e-mail and the guardian fields
--       follow the role). Refused at or after closes_at ('edits_closed', „Po zamknięciu zapisów
--       dane zmienia się w panelu pomiaru.”). Before close the participant gets the same columns
--       the bridge copies, never nationality (P2-R31).
--   rename_team(team, name, actor) → the stored name
--       Plan 5's rules (2…40 characters after NFC and whitespace collapsing, no control
--       characters) and its index: 'team_name_taken'. A released team cannot be renamed.
--
-- Locks: extend takes the order, then the settings (a prefix of the Global Constraints order);
-- edit takes the settings, then the registration; rename takes the team's order, the competition
-- FOR SHARE, the settings FOR SHARE and the team, as team_squad_edit does.

-- ---------------------------------------------------------------- extend_order_window

CREATE FUNCTION public.extend_order_window(p_order_id uuid, p_until timestamptz, p_actor uuid) RETURNS timestamptz
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o        public.orders%ROWTYPE;
  v_closes timestamptz;
  v_until  timestamptz;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT rs.closes_at INTO v_closes FROM public.registration_settings rs WHERE rs.event_id = o.event_id FOR SHARE;

  UPDATE public.orders
     SET expires_at = p_until, extended_at = now(), extended_by = p_actor, reminder_sent_at = NULL
   WHERE id = p_order_id AND status = 'pending' AND expires_at > now()
     AND p_until > expires_at
     AND p_until <= least(now() + interval '14 days', v_closes)
  RETURNING expires_at INTO v_until;
  IF FOUND THEN
    RETURN v_until;
  END IF;
  IF o.status <> 'pending' OR o.expires_at <= now() THEN
    RAISE EXCEPTION 'expired';
  END IF;
  RAISE EXCEPTION 'invalid_until';
END $$;
REVOKE EXECUTE ON FUNCTION public.extend_order_window(uuid, timestamptz, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_order_window(uuid, timestamptz, uuid) TO service_role;

-- ---------------------------------------------------------------- organizer_edit_registration

CREATE FUNCTION public.organizer_edit_registration(p_registration_id uuid, p_fields jsonb, p_actor uuid) RETURNS jsonb
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
     OR v_phone IS NULL OR v_phone !~ c_phone
     OR v_gender IS NULL OR v_gender NOT IN ('M', 'K')
     OR v_birth IS NULL OR v_birth < DATE '1900-01-01' OR v_birth > v_today
     OR char_length(v_city) > 200 OR char_length(v_club) > 200 OR char_length(v_icen) > 200
     OR (v_icep IS NOT NULL AND v_icep !~ c_phone)
     OR (v_nat IS NOT NULL AND v_nat !~ '^[A-Z]{2}$') THEN
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
    IF (public.registration_age_on(v_birth, v_today, 'race_day') < 18) <> (r.email IS NULL) THEN
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

-- ---------------------------------------------------------------- rename_team

CREATE FUNCTION public.rename_team(p_team_id uuid, p_name text, p_actor uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_team  public.teams%ROWTYPE;
  v_order uuid;
  v_name  text;
BEGIN
  -- teamNameKey's spelling (team.js): NFC, every whitespace run one space, trimmed.
  v_name := btrim(regexp_replace(normalize(coalesce(p_name, ''), NFC),
                  '[\u0009-\u000d    -     　﻿]+', ' ', 'g'),
                  ' ');
  IF char_length(v_name) NOT BETWEEN 2 AND 40 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_team_name';
  END IF;

  SELECT * INTO v_team FROM public.teams WHERE id = p_team_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT r.order_id INTO v_order FROM public.registrations r WHERE r.id = v_team.captain_registration_id;
  IF v_order IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = v_order FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.competitions WHERE category_id = v_team.category_id FOR SHARE;
  PERFORM 1 FROM public.registration_settings WHERE event_id = v_team.event_id FOR SHARE;
  SELECT * INTO v_team FROM public.teams WHERE id = p_team_id FOR UPDATE;
  IF v_team.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'team_inactive';
  END IF;

  BEGIN
    UPDATE public.teams SET name = v_name WHERE id = p_team_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'team_name_taken';
  END;
  RETURN v_name;
END $$;
REVOKE EXECUTE ON FUNCTION public.rename_team(uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_team(uuid, text, uuid) TO service_role;
