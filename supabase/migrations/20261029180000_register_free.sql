-- Race registration, plan 2 task 9: free registration.
--
-- register_free(category, people, profile, meta) creates confirmed
-- registrations for a free event in ONE transaction (spec 14.1, 14.7): the
-- edge function register-free verified the e-mail code (or the session) and
-- validated every person first, so nothing here is pending.
--
--   1. The competition row is locked (FOR UPDATE) and the event's settings
--      share-locked, so the state, window, hidden flag and capacity read here
--      are the ones the claim commits against. Concurrent registrations for
--      one competition queue on that row lock; other competitions do not.
--   2. Refusals (raised as the exception message, mapped by the edge function):
--        not_found   no such competition, a draft event, or a disabled club
--        closed      event closed, competition hidden, or now() >= closes_at
--        not_free    pricing_mode <> 'free'
--        not_open    now() < opens_at
--        consents_changed  p_meta.consentIds is not exactly the event's consents
--        duplicate   one live registration per (event, lower(email)) exists
--        full        claim_competition_slots found no room
--      Registrations are inserted BEFORE the slot claim, so a double submit
--      by one person reports `duplicate` even into a full competition.
--   3. Per person: registrations (status confirmed, consent accepted, price 0),
--      consent_acceptances (every event consent + the LESZY.RUN service
--      regulamin, accepted_as self), and the participant bridge row (spec 4.9:
--      no bib; hosts pull it because a published leszyrun-timed event passes
--      their filter). registrations.participant_id points at it.
--
-- p_people: [{ firstName, lastName, birthDate, gender, email, phone, city,
--              club, iceName, icePhone, ageGroupLabel, kidsGroupId }]
-- p_meta:   { consentIds: [uuid], ip, userAgent }
-- Returns { registrations: [{ id, participantId, email }] }.

CREATE FUNCTION public.register_free(p_category_id uuid, p_people jsonb, p_profile_id uuid, p_meta jsonb)
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
        phone, city, club, ice_name, ice_phone, age_group_label, kids_group_id, consent_state,
        list_price, price)
      VALUES (
        v_rs.event_id, p_category_id, 'confirmed',
        -- The account is this person's only when its address is theirs.
        (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email),
        v_person->>'firstName', v_person->>'lastName', (v_person->>'birthDate')::date, v_person->>'gender',
        v_email, v_person->>'phone', v_person->>'city', v_person->>'club', v_person->>'iceName',
        v_person->>'icePhone', v_person->>'ageGroupLabel', nullif(v_person->>'kidsGroupId', '')::uuid,
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
