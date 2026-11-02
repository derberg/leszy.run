-- A consent can apply only to a registration with a child in it: the „Zgoda opiekuna · dzieci”
-- preset of the Formularz step is the case. Until now every consent of an event was required
-- of every registrant, so an adult entering themself had to tick a guardian's consent.
--
-- event_consents.minors_only marks such a consent. It is shown and required only when the
-- request carries a person with role 'minor', and accepted only for that child's registration
-- (accepted_as 'guardian'). An adult's own pages (the consent request, the transfer recipient,
-- the office signature) never ask for it. Existing consents stay false: nothing is backfilled.
-- requiredConsents() in _shared/registration/consents.js is the same rule for the edge
-- functions and the pages.
--
-- Every function here is recreated from its latest body and changed only where marked:
--   * registration_group_lock (20261031100000): the required set leaves minors_only consents
--     out unless a person is a minor.
--   * registration_group_insert (20261103120000): a minors_only consent is accepted only for
--     a minor.
--   * accept_consent_request, mark_consent_office (20261031110000): an added adult's set, so
--     no minors_only consent.
--   * apply_transfer (20261103150000): the recipient is an adult, so no minors_only consent.
--   * apply_registration_section (20261104200000): the form branch stores `minorsOnly`.
--   * registration_check_locks (20261103110000): an accepted consent keeps its minors_only too.
--   * registration_raw (20261104200000): each consent carries `minorsOnly`.
-- team_squad_insert asks for consents only for a child, so every consent applies and it is
-- not recreated. CREATE OR REPLACE keeps every grant; the REVOKE / GRANT after each function
-- restates it.
--
-- form_fields' column default follows FORM_FIELD_DEFAULTS in _shared/registration/sections.js
-- (city and club required, ICE optional, nationality off). Existing rows keep their value.

ALTER TABLE public.event_consents ADD COLUMN minors_only boolean NOT NULL DEFAULT false;

ALTER TABLE public.registration_settings
  ALTER COLUMN form_fields SET DEFAULT '{"city":"required","club":"required","ice":"optional","nationality":"off"}'::jsonb;

-- ---------------------------------------------------------------- registration_group_lock (from 20261031100000)


-- The request's people checked for shape and its competitions locked (D3-1: competitions
-- in category_id order, then the settings row). Raises invalid_people, not_found,
-- mixed_events, closed, not_open and consents_changed; the caller checks pricing.
-- „At most one 'self', the session's person” is group.js's rule, not this one: the
-- old-signature wrappers mark every person 'self', as Plans 2–3 wrote them.
-- Internal: executable by nobody but the SECURITY DEFINER callers (it runs as its caller).
CREATE OR REPLACE FUNCTION public.registration_group_lock(p_people jsonb, p_meta jsonb,
                                               OUT o_settings public.registration_settings,
                                               OUT o_cats uuid[])
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_person jsonb;
  v_role   text;
  v_events uuid[];
  v_n      integer;
  v_sent   uuid[];
  v_have   uuid[];
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  FOR v_person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    IF jsonb_typeof(v_person) IS DISTINCT FROM 'object'
       OR coalesce(v_person->>'categoryId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    v_role := v_person->>'role';
    IF v_role IS NULL OR v_role NOT IN ('self', 'adult', 'minor') THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    IF nullif(btrim(v_person->>'firstName'), '') IS NULL OR nullif(btrim(v_person->>'lastName'), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    -- An adult is kept unique by the address, a child by name + birth date.
    IF v_role <> 'minor' AND nullif(btrim(v_person->>'email'), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    IF v_role = 'minor' AND nullif(v_person->>'birthDate', '') IS NULL THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT (e->>'categoryId')::uuid ORDER BY (e->>'categoryId')::uuid) INTO o_cats
    FROM jsonb_array_elements(p_people) AS e;

  -- D3-1: every competition first, in category_id order.
  PERFORM 1 FROM public.competitions c WHERE c.category_id = ANY (o_cats) ORDER BY c.category_id FOR UPDATE;
  SELECT count(*), array_agg(DISTINCT c.event_id) INTO v_n, v_events
    FROM public.competitions c WHERE c.category_id = ANY (o_cats);
  IF v_n <> cardinality(o_cats) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF cardinality(v_events) > 1 THEN
    RAISE EXCEPTION 'mixed_events';
  END IF;

  SELECT * INTO o_settings FROM public.registration_settings WHERE event_id = v_events[1] FOR SHARE;
  IF NOT FOUND OR o_settings.state = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = o_settings.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF o_settings.state <> 'published'
     OR EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = ANY (o_cats) AND c.hidden_at IS NOT NULL) THEN
    RAISE EXCEPTION 'closed';
  END IF;
  IF o_settings.opens_at IS NULL OR now() < o_settings.opens_at THEN
    RAISE EXCEPTION 'not_open';
  END IF;
  IF o_settings.closes_at IS NULL OR now() >= o_settings.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  -- D3-2 / D4-5: the payer accepted exactly the consents the form showed, image included.
  -- Changed here: a minors_only consent is shown, so required, only when a person is a minor.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec
   WHERE ec.event_id = o_settings.event_id
     AND (NOT ec.minors_only
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_people) AS e WHERE e->>'role' = 'minor'));
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_lock(jsonb, jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_group_insert (from 20261103120000)

CREATE OR REPLACE FUNCTION public.registration_group_insert(
  p_rs public.registration_settings, p_person jsonb, p_index integer, p_profile_id uuid,
  p_buyer_email text, p_buyer_name text, p_order_id uuid, p_status text, p_price integer,
  p_ip inet, p_ua text, p_list_price integer DEFAULT NULL, p_voucher_id uuid DEFAULT NULL,
  p_partner_id uuid DEFAULT NULL) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_role  text := p_person->>'role';
  v_email text := CASE WHEN p_person->>'role' = 'minor' THEN NULL ELSE lower(btrim(p_person->>'email')) END;
  v_reg   uuid;
BEGIN
  BEGIN
    INSERT INTO public.registrations (
      event_id, category_id, order_id, status, profile_id, registered_by_profile_id,
      first_name, last_name, birth_date, gender, email,
      phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id,
      guardian_profile_id, guardian_name, guardian_email, consent_state, list_price, price, voucher_id, partner_id)
    VALUES (
      p_rs.event_id, (p_person->>'categoryId')::uuid, p_order_id, p_status,
      -- The account is this person's only when its address is theirs.
      CASE WHEN v_email IS NOT NULL
           THEN (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email) END,
      p_profile_id,
      p_person->>'firstName', p_person->>'lastName', (p_person->>'birthDate')::date, p_person->>'gender', v_email,
      p_person->>'phone', p_person->>'city', p_person->>'club', p_person->>'iceName', p_person->>'icePhone',
      nullif(p_person->>'nationality', ''), p_person->>'ageGroupLabel', nullif(p_person->>'kidsGroupId', '')::uuid,
      CASE WHEN v_role = 'minor' THEN p_profile_id END,
      CASE WHEN v_role = 'minor' THEN p_buyer_name END,
      CASE WHEN v_role = 'minor' THEN p_buyer_email END,
      CASE WHEN v_role = 'adult' THEN 'awaiting' ELSE 'accepted' END,
      coalesce(p_list_price, p_price), p_price, p_voucher_id, p_partner_id)
    RETURNING id INTO v_reg;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'duplicate:%', p_index;
  END;

  -- An added adult accepts for themself later (consent request, task 3). The buyer accepts
  -- for themself, and as guardian for every child, the LESZY.RUN service regulamin included.
  -- Changed here: a minors_only consent is the guardian's, accepted for a child only.
  IF v_role IN ('self', 'minor') THEN
    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, p_profile_id, CASE WHEN v_role = 'minor' THEN 'guardian' ELSE 'self' END,
           CASE WHEN ec.kind = 'regulamin' THEN p_rs.regulamin_version END, p_ip, p_ua
      FROM public.event_consents ec
     WHERE ec.event_id = p_rs.event_id AND (v_role = 'minor' OR NOT ec.minors_only)
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', p_profile_id, CASE WHEN v_role = 'minor' THEN 'guardian' ELSE 'self' END,
           NULL, p_ip, p_ua;
  END IF;
  RETURN v_reg;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_insert(public.registration_settings, jsonb, integer, uuid, text, text,
  uuid, text, integer, inet, text, integer, uuid, uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- accept_consent_request (from 20261031110000)


-- p_edits (ruling 6): firstName, lastName, phone, city, club, iceName, icePhone, nationality,
-- birthDate, gender; strings or null. The email is never editable; an unknown key is
-- edit_invalid. Only values that differ from the stored ones count as edits, so a form
-- that sends its unchanged fields back after closes_at is not refused. Field shapes here
-- are the backstop: the edge function runs validatePerson first and words the messages.
CREATE OR REPLACE FUNCTION public.accept_consent_request(p_token_hash text, p_profile_id uuid, p_edits jsonb, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  c_allowed constant text[] := ARRAY['firstName', 'lastName', 'phone', 'city', 'club', 'iceName', 'icePhone',
                                     'nationality', 'birthDate', 'gender'];
  c_phone   constant text := '^\+?[0-9][0-9 -]{5,19}$';
  v_reg_id  uuid;
  v_event   uuid;
  v_req_id  uuid;
  r         public.registrations%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_comp    public.competitions%ROWTYPE;
  v_edits   jsonb := coalesce(p_edits, '{}'::jsonb);
  v_key     text;
  v_raw     jsonb;
  v_text    text;
  v_mode    text;
  v_changed boolean := false;
  v_today   date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_age     integer;
  v_sent    uuid[];
  v_have    uuid[];
  v_ip      inet;
  v_ua      text := left(nullif(p_meta->>'userAgent', ''), 500);
  -- the person after the edits
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
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- Found through the hash without a lock; then the settings FOR SHARE (a publish waits
  -- for us, or finished before), then the registration (lock order).
  SELECT cr.registration_id, rg.event_id INTO v_reg_id, v_event
    FROM public.consent_requests cr JOIN public.registrations rg ON rg.id = cr.registration_id
   WHERE cr.token_hash = p_token_hash;
  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = v_event FOR SHARE;
  SELECT * INTO r FROM public.registrations WHERE id = v_reg_id FOR UPDATE;

  -- The gate: one statement spends the token. A rotation or an office signature that
  -- committed while we waited leaves no row here.
  UPDATE public.consent_requests SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING id INTO v_req_id;
  IF v_req_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.consent_requests cr
                WHERE cr.token_hash = p_token_hash AND cr.used_at IS NULL AND cr.expires_at <= now()) THEN
      RETURN jsonb_build_object('status', 'expired');
    END IF;
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- From here every refusal is a raise, so the gate rolls back and the token stays unused.
  IF r.id IS NULL OR r.status <> 'confirmed' OR r.consent_state <> 'awaiting' THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF p_profile_id IS NULL OR r.email IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.id = p_profile_id AND lower(btrim(p.email)) = lower(btrim(r.email))) THEN
    RAISE EXCEPTION 'profile_mismatch';
  END IF;

  SELECT * INTO v_comp FROM public.competitions WHERE category_id = r.category_id;

  -- D4-5: exactly the consents the page showed, image included. Anything that is not a
  -- list of uuids is a consent set we do not have, never a raw cast error.
  IF jsonb_typeof(coalesce(p_meta->'consentIds', '[]'::jsonb)) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(e)
                 WHERE jsonb_typeof(e) <> 'string'
                    OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;
  -- Changed here: an adult accepts for themself, so no minors_only consent.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = r.event_id AND NOT ec.minors_only;
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;

  -- ---------------------------------------------- edits: shape
  IF jsonb_typeof(v_edits) <> 'object' THEN
    RAISE EXCEPTION 'edit_invalid';
  END IF;
  v_first := r.first_name; v_last := r.last_name; v_phone := r.phone; v_city := r.city; v_club := r.club;
  v_icen := r.ice_name; v_icep := r.ice_phone; v_nat := r.nationality; v_birth := r.birth_date; v_gender := r.gender;

  FOR v_key, v_raw IN SELECT key, value FROM jsonb_each(v_edits) LOOP
    IF NOT (v_key = ANY (c_allowed)) OR jsonb_typeof(v_raw) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'edit_invalid';
    END IF;
    v_text := nullif(btrim(v_raw #>> '{}'), '');
    CASE v_key
      WHEN 'firstName' THEN
        IF v_text IS NULL OR length(v_text) > 100 THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_first := v_text;
      WHEN 'lastName' THEN
        IF v_text IS NULL OR length(v_text) > 100 THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_last := v_text;
      WHEN 'phone' THEN
        IF v_text IS NULL OR v_text !~ c_phone THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_phone := v_text;
      WHEN 'city' THEN
        IF length(v_text) > 200 THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_city := v_text;
      WHEN 'club' THEN
        IF length(v_text) > 200 THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_club := v_text;
      WHEN 'iceName' THEN
        IF length(v_text) > 200 THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_icen := v_text;
      WHEN 'icePhone' THEN
        IF v_text IS NOT NULL AND v_text !~ c_phone THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_icep := v_text;
      WHEN 'nationality' THEN
        IF v_text IS NOT NULL AND v_text !~ '^[A-Za-z]{2}$' THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_nat := upper(v_text);
      WHEN 'birthDate' THEN
        IF v_text IS NULL OR v_text !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        BEGIN
          v_birth := v_text::date;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'edit_invalid';
        END;
        IF to_char(v_birth, 'YYYY-MM-DD') <> v_text THEN RAISE EXCEPTION 'edit_invalid'; END IF;
      WHEN 'gender' THEN
        IF v_text IS NULL OR v_text NOT IN ('M', 'K') THEN RAISE EXCEPTION 'edit_invalid'; END IF;
        v_gender := v_text;
    END CASE;
  END LOOP;

  v_changed := v_first IS DISTINCT FROM r.first_name OR v_last IS DISTINCT FROM r.last_name
            OR v_phone IS DISTINCT FROM r.phone OR v_city IS DISTINCT FROM r.city OR v_club IS DISTINCT FROM r.club
            OR v_icen IS DISTINCT FROM r.ice_name OR v_icep IS DISTINCT FROM r.ice_phone
            OR v_nat IS DISTINCT FROM r.nationality OR v_birth IS DISTINCT FROM r.birth_date
            OR v_gender IS DISTINCT FROM r.gender;

  -- §14.3: nothing is editable once registration has closed.
  IF v_changed AND now() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'edits_closed';
  END IF;

  -- ---------------------------------------------- edits: the event's form and the competition
  IF v_changed THEN
    -- A switched-off field cannot be set, a required one cannot be cleared.
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

    -- Birth date and gender: the person stays an adult (judged today, as validatePerson
    -- does) and eligible for the competition (judged on race day by the event's reckoning).
    v_label := r.age_group_label;
    v_kids := r.kids_group_id;
    IF v_birth IS DISTINCT FROM r.birth_date OR v_gender IS DISTINCT FROM r.gender THEN
      IF v_birth IS NULL OR v_gender IS NULL OR v_birth < DATE '1900-01-01' OR v_birth > v_today THEN
        RAISE EXCEPTION 'edit_invalid';
      END IF;
      IF public.registration_age_on(v_birth, v_today, 'race_day') < 18 THEN
        RAISE EXCEPTION 'edit_invalid';
      END IF;
      v_age := public.registration_age_on(v_birth, coalesce(v_rs.event_date, v_today), v_rs.age_reckoning);
      IF (v_comp.min_age IS NOT NULL AND v_age < v_comp.min_age) OR (v_comp.max_age IS NOT NULL AND v_age > v_comp.max_age) THEN
        RAISE EXCEPTION 'edit_invalid';
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
  END IF;

  -- ---------------------------------------------- writes
  UPDATE public.registrations
     SET consent_state = 'accepted', profile_id = p_profile_id,
         first_name = v_first, last_name = v_last, phone = v_phone, city = v_city, club = v_club,
         ice_name = v_icen, ice_phone = v_icep, nationality = v_nat, birth_date = v_birth, gender = v_gender,
         age_group_label = CASE WHEN v_changed THEN v_label ELSE age_group_label END,
         kids_group_id = CASE WHEN v_changed THEN v_kids ELSE kids_group_id END
   WHERE id = r.id;

  -- The participant only before closes_at (spec 14.3; v_changed implies it here), and only
  -- the columns the bridge copies (never nationality, P2-R31).
  IF v_changed AND r.participant_id IS NOT NULL THEN
    UPDATE public.participants
       SET first_name = v_first, last_name = v_last, gender = v_gender, birth_date = v_birth,
           club = v_club, phone = v_phone, updated_at = now()
     WHERE id = r.participant_id;
  END IF;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  INSERT INTO public.consent_acceptances (
    registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
  SELECT r.id, ec.id, ec.kind, p_profile_id, 'self',
         CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
    FROM public.event_consents ec WHERE ec.event_id = r.event_id AND NOT ec.minors_only
  UNION ALL
  SELECT r.id, NULL, 'service_regulamin', p_profile_id, 'self', NULL, v_ip, v_ua;

  RETURN jsonb_build_object('status', 'accepted', 'registrationId', r.id, 'eventId', r.event_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.accept_consent_request(text, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_consent_request(text, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------- mark_consent_office (from 20261031110000)

-- „Podpisany w biurze”: the person signed the event's terms on paper. The acceptances are
-- the event consents only, recorded as 'office' by the organizer: the person never used
-- the service, so no service_regulamin acceptance is invented for them.
CREATE OR REPLACE FUNCTION public.mark_consent_office(p_registration_id uuid, p_actor uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_event   uuid;
  v_done    uuid;
  v_version integer;
BEGIN
  -- Lock order: settings FOR SHARE, then the registration (as accept_consent_request).
  SELECT event_id INTO v_event FROM public.registrations WHERE id = p_registration_id;
  IF v_event IS NULL THEN
    RETURN false;
  END IF;
  SELECT rs.regulamin_version INTO v_version FROM public.registration_settings rs WHERE rs.event_id = v_event FOR SHARE;
  PERFORM 1 FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  UPDATE public.registrations SET consent_state = 'office'
   WHERE id = p_registration_id AND consent_state = 'awaiting' AND status = 'confirmed'
  RETURNING id INTO v_done;
  IF v_done IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.consent_acceptances (
    registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
  SELECT p_registration_id, ec.id, ec.kind, p_actor, 'office',
         CASE WHEN ec.kind = 'regulamin' THEN v_version END, NULL, NULL
    FROM public.event_consents ec WHERE ec.event_id = v_event AND NOT ec.minors_only;

  UPDATE public.consent_requests SET used_at = now()
   WHERE registration_id = p_registration_id AND used_at IS NULL;
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION public.mark_consent_office(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_consent_office(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------- apply_transfer (from 20261103150000)

-- p_person: the recipient as the forms send a person (firstName, lastName, email, birthDate, gender,
-- phone, city, club, iceName, icePhone, nationality, ageGroupLabel). p_kind 'runner': the recipient
-- accepts for themself (p_profile_id is their account, p_consent { consentIds, serviceRegulamin,
-- ip, userAgent }), consent_state 'accepted'. p_kind 'organizer': typed in by p_actor, consent_state
-- 'awaiting' (Plan 4's consent request follows). p_actor is registered_by_profile_id.
-- p_transfer_id: the invite an accept answers; checked once the locks are held, so a used, cancelled
-- or expired link answers gone before anything else.
CREATE OR REPLACE FUNCTION public.apply_transfer(p_registration_id uuid, p_person jsonb, p_category_id uuid,
                                      p_profile_id uuid, p_consent jsonb, p_kind text,
                                      p_actor uuid DEFAULT NULL, p_transfer_id uuid DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  c_live      constant text[] := ARRAY['pending_payment', 'confirmed'];
  r           public.registrations%ROWTYPE;
  v_rec       public.registrations%ROWTYPE;
  o           public.orders%ROWTYPE;
  v_rs        public.registration_settings%ROWTYPE;
  v_comp      public.competitions%ROWTYPE;
  v_team      public.teams%ROWTYPE;
  v_email     text := lower(btrim(p_person->>'email'));
  v_birth     date;
  v_rec_order uuid;
  v_orders    uuid[];
  v_cats      uuid[];
  v_price     integer;
  v_sent      uuid[];
  v_have      uuid[];
  v_ip        inet;
  v_ua        text := left(nullif(p_consent->>'userAgent', ''), 500);
  v_new       uuid;
  v_part      uuid;
  v_host      boolean := false;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('runner', 'organizer') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;
  IF jsonb_typeof(p_person) IS DISTINCT FROM 'object'
     OR nullif(btrim(p_person->>'firstName'), '') IS NULL OR nullif(btrim(p_person->>'lastName'), '') IS NULL
     OR v_email IS NULL OR v_email = '' OR nullif(p_person->>'birthDate', '') IS NULL THEN
    RAISE EXCEPTION 'invalid_person';
  END IF;
  -- The shape transfers.to_email and the organizer's record need (m-4), refused before any work.
  IF char_length(v_email) > 254 OR v_email NOT LIKE '%_@_%' OR v_email ~ '\s' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  BEGIN
    v_birth := (p_person->>'birthDate')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_person';
  END;

  -- Plain reads: what to lock.
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT x.order_id INTO v_rec_order FROM public.registrations x
   WHERE x.event_id = r.event_id AND x.email IS NOT NULL AND lower(x.email) = v_email
     AND x.status = 'pending_payment' AND x.order_id IS NOT NULL
   LIMIT 1;

  -- 1. orders, by id.
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_orders
    FROM unnest(ARRAY[r.order_id, v_rec_order]) AS u(x) WHERE x IS NOT NULL;
  PERFORM 1 FROM public.orders WHERE id = ANY (v_orders) ORDER BY id FOR UPDATE;
  -- 2. the old entry's lines.
  IF r.order_id IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = r.order_id;
    PERFORM 1 FROM public.order_lines
     WHERE order_id = r.order_id AND registration_id = r.id AND kind IN ('entry', 'extra')
     ORDER BY id FOR UPDATE;
  END IF;
  -- 3. every competition involved (the recipient's order's hold no slot, P3-R15, but take the one
  --    lock pattern), by category_id.
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_cats FROM (
    SELECT r.category_id UNION SELECT p_category_id
    UNION SELECT y.category_id FROM public.registrations y WHERE v_rec_order IS NOT NULL AND y.order_id = v_rec_order
  ) AS s(x) WHERE x IS NOT NULL;
  PERFORM 1 FROM public.competitions WHERE category_id = ANY (v_cats) ORDER BY category_id FOR UPDATE;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id;
  IF NOT FOUND OR v_comp.event_id <> r.event_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- 4. settings, 5. the team.
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  IF r.team_id IS NOT NULL THEN
    SELECT * INTO v_team FROM public.teams WHERE id = r.team_id FOR UPDATE;
  END IF;
  -- 6. vouchers by id: the old entry's (the new row's foreign key reads it) together with those the
  --    recipient's unpaid order would give back; then that order's variants by id; then the
  --    partner the new row's foreign key reads (m-1).
  PERFORM 1 FROM public.vouchers v
   WHERE v.id = r.voucher_id
      OR (v_rec_order IS NOT NULL AND v.id IN (SELECT y.voucher_id FROM public.registrations y
                                                WHERE y.order_id = v_rec_order AND y.status = 'pending_payment'))
   ORDER BY v.id
     FOR UPDATE;
  IF v_rec_order IS NOT NULL THEN
    PERFORM public.registration_lock_unpaid_cart(ARRAY[v_rec_order]);
  END IF;
  IF r.partner_id IS NOT NULL THEN
    PERFORM 1 FROM public.registration_partners WHERE id = r.partner_id FOR KEY SHARE;
  END IF;
  -- 7. the registrations, by id.
  PERFORM 1 FROM public.registrations
   WHERE id = r.id OR (v_rec_order IS NOT NULL AND order_id = v_rec_order)
   ORDER BY id FOR UPDATE;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;

  -- Checks, with every lock held.
  IF p_transfer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.transfers t
        WHERE t.id = p_transfer_id AND t.registration_id = r.id AND t.status = 'pending' AND t.expires_at > now()) THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF public.registration_refund_in_flight(r.id) THEN
    RAISE EXCEPTION 'refund_pending';
  END IF;
  -- I-1: an open invite follows the organizer's switch and date (§5.4). The settings row is held FOR
  -- SHARE, so a save of the payments section waits for this accept or this accept sees it.
  IF p_kind = 'runner'
     AND (NOT v_rs.transfer_enabled OR v_rs.transfer_until IS NULL
          OR (now() AT TIME ZONE 'Europe/Warsaw')::date > v_rs.transfer_until) THEN
    RAISE EXCEPTION 'transfer_off';
  END IF;
  IF r.email IS NULL OR r.guardian_profile_id IS NOT NULL
     OR r.birth_date IS NULL OR r.birth_date > (v_rs.event_date - interval '18 years')::date
     OR (r.team_id IS NOT NULL AND v_team.captain_registration_id IS DISTINCT FROM r.id) THEN
    RAISE EXCEPTION 'not_transferable';
  END IF;
  IF v_email = lower(btrim(r.email)) THEN
    RAISE EXCEPTION 'same_person';
  END IF;
  IF v_birth > (v_rs.event_date - interval '18 years')::date THEN
    RAISE EXCEPTION 'recipient_minor';
  END IF;
  IF (r.team_id IS NOT NULL AND p_category_id <> r.category_id)
     OR (r.team_id IS NULL AND v_comp.kind = 'team') THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  IF p_category_id <> r.category_id AND v_comp.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'unavailable';
  END IF;
  -- Ruling 2: the target's list price in the old order's frozen tier.
  v_price := CASE WHEN o.tier_id IS NULL THEN 0 ELSE public.registration_tier_price(p_category_id, o.tier_id) END;
  IF v_price IS DISTINCT FROM r.list_price THEN
    RAISE EXCEPTION 'price_differs';
  END IF;
  IF p_kind = 'runner' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_profile_id AND lower(btrim(p.email)) = v_email) THEN
      RAISE EXCEPTION 'profile_mismatch';
    END IF;
    IF jsonb_typeof(p_consent) IS DISTINCT FROM 'object' OR (p_consent->'serviceRegulamin') IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'consents_required';
    END IF;
    IF jsonb_typeof(coalesce(p_consent->'consentIds', '[]'::jsonb)) <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_consent->'consentIds', '[]'::jsonb)) AS t(e)
                   WHERE jsonb_typeof(e) <> 'string'
                      OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
    -- Changed here: the recipient is an adult, so no minors_only consent.
    SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
      FROM jsonb_array_elements_text(coalesce(p_consent->'consentIds', '[]'::jsonb)) AS t(x);
    SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
      FROM public.event_consents ec WHERE ec.event_id = r.event_id AND NOT ec.minors_only;
    IF v_sent IS DISTINCT FROM v_have THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
  END IF;

  -- The recipient's own live entry, read again under the locks.
  SELECT * INTO v_rec FROM public.registrations x
   WHERE x.event_id = r.event_id AND x.email IS NOT NULL AND lower(x.email) = v_email AND x.status = ANY (c_live)
   LIMIT 1;
  IF FOUND THEN
    IF v_rec.status = 'confirmed' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    IF v_rec.order_id IS NULL OR v_rec.order_id IS DISTINCT FROM v_rec_order THEN
      RAISE EXCEPTION 'transfer_retry' USING ERRCODE = '40001';
    END IF;
    IF (SELECT count(*) FROM public.registrations x WHERE x.order_id = v_rec.order_id) > 1 THEN
      RAISE EXCEPTION 'pending_elsewhere';
    END IF;
    -- §2: an unpaid entry alone in its order is replaced. It held no slot (P3-R15); its voucher
    -- uses and stock go back (D7-18). Every lock it needs is held.
    PERFORM public.cancel_order(v_rec.order_id, 'transfer_accepted');
  END IF;

  -- 3. the new registration, with the old one's money.
  BEGIN
    v_ip := nullif(p_consent->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  BEGIN
    v_new := public.registration_group_insert(
      v_rs,
      p_person || jsonb_build_object('categoryId', p_category_id,
                                     'role', CASE WHEN p_kind = 'runner' THEN 'self' ELSE 'adult' END,
                                     'email', v_email),
      0, coalesce(p_actor, p_profile_id), NULL, NULL, r.order_id, 'confirmed', r.price, v_ip, v_ua,
      r.list_price, r.voucher_id, r.partner_id);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'duplicate:%' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    RAISE;
  END;
  UPDATE public.registrations
     SET team_id = r.team_id, team_position = r.team_position, refunded = r.refunded
   WHERE id = v_new;
  -- Carry from task 2: the captain role moves before the old row leaves live.
  IF r.team_id IS NOT NULL THEN
    UPDATE public.teams SET captain_registration_id = v_new WHERE id = r.team_id AND captain_registration_id = r.id;
  END IF;

  -- 4. the old registration leaves live (the refunded amount goes with the line).
  UPDATE public.registrations SET status = 'transferred_out', refunded = 0
   WHERE id = r.id AND status = 'confirmed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gone';
  END IF;
  IF r.team_leg IS NOT NULL THEN
    UPDATE public.registrations SET team_leg = r.team_leg WHERE id = v_new;
  END IF;

  -- 5. the lines follow.
  IF r.order_id IS NOT NULL THEN
    UPDATE public.order_lines SET registration_id = v_new
     WHERE order_id = r.order_id AND registration_id = r.id AND kind IN ('entry', 'extra');
  END IF;

  -- 6. a confirmed slot moves, with no capacity check (§4.8).
  IF p_category_id <> r.category_id THEN
    UPDATE public.competitions SET taken = taken - 1 WHERE category_id = r.category_id;
    UPDATE public.competitions SET taken = taken + 1 WHERE category_id = p_category_id;
  END IF;

  -- 7. participants (§14.3, D7-24).
  IF r.participant_id IS NOT NULL THEN
    IF v_rs.closes_at IS NOT NULL AND clock_timestamp() < v_rs.closes_at THEN
      UPDATE public.participants SET removed_at = now(), updated_at = now()
       WHERE id = r.participant_id AND removed_at IS NULL;
    ELSE
      INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
      SELECT 'host_withdraw', r.order_id,
             jsonb_build_object('reason', 'transfer', 'registrationId', r.id, 'eventId', r.event_id,
                                'bib', p.bib_number),
             'host_withdraw:transfer:' || r.id
        FROM public.participants p WHERE p.id = r.participant_id
      ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
      v_host := true;
    END IF;
  END IF;
  v_part := public.insert_registration_participant(v_new);

  RETURN jsonb_build_object(
    'registrationId', v_new, 'oldRegistrationId', r.id, 'participantId', v_part, 'hostWithdraw', v_host,
    'senderProfileId', r.profile_id, 'senderEmail', r.email, 'eventId', r.event_id, 'orderId', r.order_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_transfer(uuid, jsonb, uuid, uuid, jsonb, text, uuid, uuid)
  FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- apply_registration_section (from 20261104200000)

CREATE OR REPLACE FUNCTION public.apply_registration_section(p_event_id uuid, p_section text, p_value jsonb, p_allow_delete boolean)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_state  text;
  v_item   jsonb;
  v_idx    integer := 0;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_tier   uuid;
  v_del    record;
  v_result jsonb := '{}'::jsonb;
  v_t      jsonb;
  v_n      bigint;
  v_keys   jsonb := '{}'::jsonb;
  v_tiers  uuid[] := '{}';
  v_x      jsonb;
  v_v      jsonb;
  v_m      bigint;
  v_extra  uuid;
  v_var    uuid;
  v_vids   uuid[];
  v_xids   uuid[] := '{}';
  v_nested jsonb := '[]'::jsonb;
BEGIN
  SELECT rs.state INTO v_state FROM public.registration_settings rs WHERE rs.event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_section = 'basics' THEN
    IF p_value ? 'slug' AND (
         EXISTS (SELECT 1 FROM public.events e WHERE e.slug = p_value->>'slug' AND e.id <> p_event_id)
      OR EXISTS (SELECT 1 FROM public.registration_settings rs
                  WHERE rs.slug = p_value->>'slug' AND rs.event_id <> p_event_id)) THEN
      RAISE EXCEPTION 'slug_taken';
    END IF;
    IF p_value ? 'poster_upload_id' THEN
      PERFORM public.registration_check_upload(p_event_id, p_value->>'poster_upload_id', 'poster');
    END IF;
    IF p_value ? 'regulamin_upload_id' THEN
      PERFORM public.registration_check_upload(p_event_id, p_value->>'regulamin_upload_id', 'regulamin');
    END IF;
    BEGIN
      UPDATE public.registration_settings SET
        name                = CASE WHEN p_value ? 'name' THEN p_value->>'name' ELSE name END,
        slug                = CASE WHEN p_value ? 'slug' THEN p_value->>'slug' ELSE slug END,
        event_date          = CASE WHEN p_value ? 'event_date' THEN (p_value->>'event_date')::date ELSE event_date END,
        first_start_time    = CASE WHEN p_value ? 'first_start_time' THEN (p_value->>'first_start_time')::time ELSE first_start_time END,
        opens_at            = CASE WHEN p_value ? 'opens_at' THEN (p_value->>'opens_at')::timestamptz ELSE opens_at END,
        closes_at           = CASE WHEN p_value ? 'closes_at' THEN (p_value->>'closes_at')::timestamptz ELSE closes_at END,
        is_charity          = CASE WHEN p_value ? 'is_charity' THEN (p_value->>'is_charity')::boolean ELSE is_charity END,
        charity_goal        = CASE WHEN p_value ? 'charity_goal' THEN p_value->>'charity_goal' ELSE charity_goal END,
        donations_enabled   = CASE WHEN p_value ? 'donations_enabled' THEN (p_value->>'donations_enabled')::boolean ELSE donations_enabled END,
        town_label          = CASE WHEN p_value ? 'town_label' THEN p_value->>'town_label' ELSE town_label END,
        town_area           = CASE WHEN p_value ? 'town_area' THEN p_value->>'town_area' ELSE town_area END,
        place_details       = CASE WHEN p_value ? 'place_details' THEN p_value->>'place_details' ELSE place_details END,
        lat                 = CASE WHEN p_value ? 'lat' THEN (p_value->>'lat')::numeric ELSE lat END,
        lng                 = CASE WHEN p_value ? 'lng' THEN (p_value->>'lng')::numeric ELSE lng END,
        regulamin_kind      = CASE WHEN p_value ? 'regulamin_kind' THEN p_value->>'regulamin_kind' ELSE regulamin_kind END,
        regulamin_url       = CASE WHEN p_value ? 'regulamin_url' THEN p_value->>'regulamin_url' ELSE regulamin_url END,
        regulamin_upload_id = CASE WHEN p_value ? 'regulamin_upload_id' THEN (p_value->>'regulamin_upload_id')::uuid ELSE regulamin_upload_id END,
        poster_upload_id    = CASE WHEN p_value ? 'poster_upload_id' THEN (p_value->>'poster_upload_id')::uuid ELSE poster_upload_id END,
        contact_email       = CASE WHEN p_value ? 'contact_email' THEN p_value->>'contact_email' ELSE contact_email END,
        -- new: the description and the cause's page
        description         = CASE WHEN p_value ? 'description' THEN p_value->>'description' ELSE description END,
        charity_url         = CASE WHEN p_value ? 'charity_url' THEN p_value->>'charity_url' ELSE charity_url END
      WHERE event_id = p_event_id;
    EXCEPTION WHEN unique_violation THEN
      -- a concurrent save claimed the slug after the check above
      RAISE EXCEPTION 'slug_taken';
    END;

  ELSIF p_section = 'office' THEN
    UPDATE public.registration_settings SET
      office_same_as_event = CASE WHEN p_value ? 'office_same_as_event' THEN (p_value->>'office_same_as_event')::boolean ELSE office_same_as_event END,
      office_address       = CASE WHEN p_value ? 'office_address' THEN p_value->>'office_address' ELSE office_address END,
      office_notes         = CASE WHEN p_value ? 'office_notes' THEN p_value->>'office_notes' ELSE office_notes END,
      office_lat           = CASE WHEN p_value ? 'office_lat' THEN (p_value->>'office_lat')::numeric ELSE office_lat END,
      office_lng           = CASE WHEN p_value ? 'office_lng' THEN (p_value->>'office_lng')::numeric ELSE office_lng END
    WHERE event_id = p_event_id;
    IF p_value ? 'hours' THEN
      DELETE FROM public.office_hours WHERE event_id = p_event_id;
      -- Hours are Warsaw wall-clock times.
      INSERT INTO public.office_hours (event_id, starts_at, ends_at, note)
      SELECT p_event_id,
             ((h->>'date')::date + (h->>'from')::time) AT TIME ZONE 'Europe/Warsaw',
             ((h->>'date')::date + (h->>'to')::time) AT TIME ZONE 'Europe/Warsaw',
             nullif(btrim(h->>'note'), '')
        FROM jsonb_array_elements(p_value->'hours') AS h;
    END IF;

  ELSIF p_section = 'competitions' THEN
    -- Every referenced id must belong to this event.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
       WHERE i->>'category_id' IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.competitions c
                          WHERE c.category_id = (i->>'category_id')::uuid AND c.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
      IF v_item ? 'gpx_upload_id' THEN
        PERFORM public.registration_check_upload(p_event_id, v_item->>'gpx_upload_id', 'gpx');
      END IF;
    END LOOP;

    -- Competitions left out of the list are deleted, child rows first, only in
    -- a draft and only while nobody registered. The category goes last, with
    -- the delete-refusal trigger's draft exception switched on for that one
    -- statement.
    FOR v_del IN
      SELECT c.category_id, c.taken FROM public.competitions c
       WHERE c.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
                          WHERE (i->>'category_id')::uuid = c.category_id)
       FOR UPDATE
    LOOP
      IF NOT p_allow_delete OR v_state <> 'draft' OR v_del.taken > 0 THEN
        RAISE EXCEPTION 'competition_locked';
      END IF;
      -- A voucher or an extra restricted to this competition would silently widen to every
      -- competition once its last link went (the links are RESTRICT for that reason): refused,
      -- the organizer changes the code or the extra first.
      IF EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.category_id = v_del.category_id)
         OR EXISTS (SELECT 1 FROM public.extra_competitions ec WHERE ec.category_id = v_del.category_id) THEN
        RAISE EXCEPTION 'competition_linked';
      END IF;
      DELETE FROM public.competition_prices WHERE category_id = v_del.category_id;
      DELETE FROM public.age_groups WHERE category_id = v_del.category_id;
      DELETE FROM public.kids_groups WHERE category_id = v_del.category_id;
      DELETE FROM public.competitions WHERE category_id = v_del.category_id;
      PERFORM set_config('leszyrun.registration_draft_delete', 'on', true);
      DELETE FROM public.categories WHERE id = v_del.category_id;
      PERFORM set_config('leszyrun.registration_draft_delete', 'off', true);
    END LOOP;

    UPDATE public.registration_settings SET pricing_mode = p_value->>'pricing_mode' WHERE event_id = p_event_id;
    IF p_value->>'pricing_mode' = 'fixed' THEN
      -- Fixed pricing = exactly one tier, open until registration closes. Coming from tiered, the
      -- tier in force today is the one kept (an order's frozen tier_id keeps pointing at it).
      SELECT t.o_id INTO v_tier FROM public.registration_current_tier(p_event_id) t;
      IF v_tier IS NULL THEN
        SELECT t.id INTO v_tier FROM public.price_tiers t
         WHERE t.event_id = p_event_id AND t.ends_on IS NULL ORDER BY t.sort_order LIMIT 1;
      END IF;
      IF v_tier IS NULL THEN
        INSERT INTO public.price_tiers (event_id, ends_on, sort_order) VALUES (p_event_id, NULL, 0)
        RETURNING id INTO v_tier;
      END IF;
      DELETE FROM public.price_tiers WHERE event_id = p_event_id AND id <> v_tier;
      UPDATE public.price_tiers SET ends_on = NULL, sort_order = 0 WHERE id = v_tier;
    ELSIF p_value->>'pricing_mode' = 'tiered' THEN
      -- Tiers in the grid's order (validateTiers checked the dates). An id must be this event's;
      -- a tier left out goes, its prices with it (competition_prices cascade). A new tier's key
      -- in items[].prices is new:<index>.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'tiers') AS t
         WHERE t->>'id' IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.price_tiers pt
                            WHERE pt.id = (t->>'id')::uuid AND pt.event_id = p_event_id)) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.price_tiers pt
       WHERE pt.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'tiers') AS t
                          WHERE (t->>'id')::uuid = pt.id);
      FOR v_t, v_n IN SELECT value, ordinality - 1 FROM jsonb_array_elements(p_value->'tiers') WITH ORDINALITY LOOP
        IF v_t->>'id' IS NULL THEN
          INSERT INTO public.price_tiers (event_id, ends_on, sort_order)
          VALUES (p_event_id, (v_t->>'ends_on')::date, v_n)
          RETURNING id INTO v_tier;
          v_keys := v_keys || jsonb_build_object('new:' || v_n, v_tier);
        ELSE
          v_tier := (v_t->>'id')::uuid;
          UPDATE public.price_tiers SET ends_on = (v_t->>'ends_on')::date, sort_order = v_n WHERE id = v_tier;
          v_keys := v_keys || jsonb_build_object(v_tier::text, v_tier);
        END IF;
        v_tiers := v_tiers || v_tier;
      END LOOP;
    ELSE
      DELETE FROM public.price_tiers WHERE event_id = p_event_id;
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
      v_idx := v_idx + 1;
      v_id := (v_item->>'category_id')::uuid;
      IF v_id IS NULL THEN
        -- A draft category carries a placeholder name and slug; publish writes
        -- the competition's real name (anon can read categories).
        v_id := gen_random_uuid();
        INSERT INTO public.categories (id, event_id, name, slug, untimed)
        VALUES (v_id, p_event_id, 'Szkic ' || v_idx, 'szkic-' || v_id, NOT (v_item->>'timed')::boolean);
        INSERT INTO public.competitions (category_id, event_id, name, kind, discipline, distance_label, start_time,
                                         capacity, min_age, max_age, is_kids, timed, gpx_upload_id, sort_order,
                                         team_min, team_max)
        VALUES (v_id, p_event_id, v_item->>'name', v_item->>'kind', v_item->>'discipline', v_item->>'distance_label',
                (v_item->>'start_time')::time, (v_item->>'capacity')::integer, (v_item->>'min_age')::integer,
                (v_item->>'max_age')::integer, (v_item->>'is_kids')::boolean, (v_item->>'timed')::boolean,
                (v_item->>'gpx_upload_id')::uuid, v_idx,
                (v_item->>'team_min')::integer, (v_item->>'team_max')::integer);
      ELSE
        -- The limit check is in the writing statement: a registration landing
        -- meanwhile either commits first and blocks this, or waits and meets it.
        UPDATE public.competitions SET
          name = v_item->>'name', kind = v_item->>'kind', discipline = v_item->>'discipline',
          distance_label = v_item->>'distance_label', start_time = (v_item->>'start_time')::time,
          capacity = (v_item->>'capacity')::integer, min_age = (v_item->>'min_age')::integer,
          max_age = (v_item->>'max_age')::integer, is_kids = (v_item->>'is_kids')::boolean,
          timed = (v_item->>'timed')::boolean, gpx_upload_id = (v_item->>'gpx_upload_id')::uuid, sort_order = v_idx,
          -- A payload staged before this migration has no size keys: it keeps the stored one.
          team_min = CASE WHEN v_item ? 'team_min' THEN (v_item->>'team_min')::integer ELSE team_min END,
          team_max = CASE WHEN v_item ? 'team_max' THEN (v_item->>'team_max')::integer ELSE team_max END,
          -- Leg order only exists on a team: going back to individual clears it.
          leg_order_enabled = leg_order_enabled AND v_item->>'kind' = 'team'
        WHERE category_id = v_id AND taken <= (v_item->>'capacity')::integer;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'capacity_below_taken:%', v_id;
        END IF;
        UPDATE public.categories SET untimed = NOT (v_item->>'timed')::boolean WHERE id = v_id;
      END IF;
      IF p_value->>'pricing_mode' = 'fixed' THEN
        INSERT INTO public.competition_prices (category_id, tier_id, amount)
        VALUES (v_id, v_tier, (v_item->>'price')::integer)
        ON CONFLICT (category_id, tier_id) DO UPDATE SET amount = EXCLUDED.amount;
      ELSIF p_value->>'pricing_mode' = 'tiered' THEN
        -- One price per tier, keyed as the tiers were above: nothing missing, nothing extra.
        IF jsonb_typeof(v_item->'prices') IS DISTINCT FROM 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(v_item->'prices')) <> cardinality(v_tiers)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item->'prices') AS k WHERE NOT v_keys ? k) THEN
          RAISE EXCEPTION 'foreign_id';
        END IF;
        INSERT INTO public.competition_prices (category_id, tier_id, amount)
        SELECT v_id, (v_keys->>e.key)::uuid, (e.value)::text::integer
          FROM jsonb_each(v_item->'prices') AS e
        ON CONFLICT (category_id, tier_id) DO UPDATE SET amount = EXCLUDED.amount;
      END IF;
      v_ids := v_ids || v_id;
    END LOOP;
    v_result := jsonb_build_object('categoryIds', to_jsonb(v_ids));
    IF p_value->>'pricing_mode' = 'tiered' THEN
      v_result := v_result || jsonb_build_object('tierIds', to_jsonb(v_tiers));
    END IF;

  ELSIF p_section = 'categories' THEN
    IF p_value ? 'age_reckoning' THEN
      UPDATE public.registration_settings SET age_reckoning = p_value->>'age_reckoning' WHERE event_id = p_event_id;
    END IF;
    IF p_value ? 'age_groups' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'age_groups') AS g
         WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                            WHERE c.category_id = (g->>'category_id')::uuid AND c.event_id = p_event_id)
            OR (g->>'id' IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM public.age_groups ag JOIN public.competitions c ON c.category_id = ag.category_id
                   WHERE ag.id = (g->>'id')::uuid AND c.event_id = p_event_id))) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.age_groups ag USING public.competitions c
       WHERE ag.category_id = c.category_id AND c.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'age_groups') AS g
                          WHERE (g->>'id')::uuid = ag.id);
      v_ids := '{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'age_groups') LOOP
        v_id := (v_item->>'id')::uuid;
        IF v_id IS NULL THEN
          INSERT INTO public.age_groups (category_id, gender, label, min_age, max_age)
          VALUES ((v_item->>'category_id')::uuid, v_item->>'gender', v_item->>'label',
                  (v_item->>'min_age')::integer, (v_item->>'max_age')::integer)
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.age_groups SET category_id = (v_item->>'category_id')::uuid, gender = v_item->>'gender',
                 label = v_item->>'label', min_age = (v_item->>'min_age')::integer, max_age = (v_item->>'max_age')::integer
           WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := v_result || jsonb_build_object('ageGroupIds', to_jsonb(v_ids));
    END IF;
    IF p_value ? 'kids_groups' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'kids_groups') AS g
         WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                            WHERE c.category_id = (g->>'category_id')::uuid AND c.event_id = p_event_id)
            OR (g->>'id' IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM public.kids_groups kg JOIN public.competitions c ON c.category_id = kg.category_id
                   WHERE kg.id = (g->>'id')::uuid AND c.event_id = p_event_id))) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.kids_groups kg USING public.competitions c
       WHERE kg.category_id = c.category_id AND c.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'kids_groups') AS g
                          WHERE (g->>'id')::uuid = kg.id);
      v_ids := '{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'kids_groups') LOOP
        v_id := (v_item->>'id')::uuid;
        IF v_id IS NULL THEN
          INSERT INTO public.kids_groups (category_id, label, birth_year_from, birth_year_to, gender, distance_label)
          VALUES ((v_item->>'category_id')::uuid, v_item->>'label', (v_item->>'birth_year_from')::integer,
                  (v_item->>'birth_year_to')::integer, v_item->>'gender', v_item->>'distance_label')
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.kids_groups SET category_id = (v_item->>'category_id')::uuid, label = v_item->>'label',
                 birth_year_from = (v_item->>'birth_year_from')::integer, birth_year_to = (v_item->>'birth_year_to')::integer,
                 gender = v_item->>'gender', distance_label = v_item->>'distance_label'
           WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := v_result || jsonb_build_object('kidsGroupIds', to_jsonb(v_ids));
    END IF;

  ELSIF p_section = 'timing' THEN
    UPDATE public.registration_settings SET
      timing_mode      = CASE WHEN p_value ? 'timing_mode' THEN p_value->>'timing_mode' ELSE timing_mode END,
      timing_company   = CASE WHEN p_value ? 'timing_company' THEN p_value->>'timing_company' ELSE timing_company END,
      results_url      = CASE WHEN p_value ? 'results_url' THEN p_value->>'results_url' ELSE results_url END,
      live_results_url = CASE WHEN p_value ? 'live_results_url' THEN p_value->>'live_results_url' ELSE live_results_url END
    WHERE event_id = p_event_id;

  ELSIF p_section = 'form' THEN
    IF p_value ? 'form_fields' THEN
      UPDATE public.registration_settings SET form_fields = p_value->'form_fields' WHERE event_id = p_event_id;
    END IF;
    IF p_value ? 'consents' THEN
      -- One entry per consent: a repeated id would update the row twice.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
         WHERE k->>'id' IS NOT NULL
         GROUP BY k->>'id' HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'duplicate_id';
      END IF;
      -- Only custom consents are listed; regulamin and data_info stay as created.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
         WHERE k->>'id' IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.event_consents ec
            WHERE ec.id = (k->>'id')::uuid AND ec.event_id = p_event_id AND ec.kind = 'custom')) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      DELETE FROM public.event_consents ec
       WHERE ec.event_id = p_event_id AND ec.kind = 'custom'
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
                          WHERE (k->>'id')::uuid = ec.id);
      v_ids := '{}';
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'consents') LOOP
        v_idx := v_idx + 1;
        v_id := (v_item->>'id')::uuid;
        -- Changed here: minorsOnly is stored, false when absent.
        IF v_id IS NULL THEN
          INSERT INTO public.event_consents (event_id, kind, text, sort_order, minors_only)
          VALUES (p_event_id, 'custom', v_item->>'text', 1 + v_idx, coalesce((v_item->>'minorsOnly')::boolean, false))
          RETURNING id INTO v_id;
        ELSE
          UPDATE public.event_consents
             SET text = v_item->>'text', sort_order = 1 + v_idx,
                 minors_only = coalesce((v_item->>'minorsOnly')::boolean, false)
           WHERE id = v_id;
        END IF;
        v_ids := v_ids || v_id;
      END LOOP;
      v_result := jsonb_build_object('consentIds', to_jsonb(v_ids));
    END IF;
    IF p_value ? 'leg_order' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_value->'leg_order') AS k
         WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                            WHERE c.category_id = k::uuid AND c.event_id = p_event_id)) THEN
        RAISE EXCEPTION 'foreign_id';
      END IF;
      -- Publish applies competitions before form, so a competition staged back to
      -- individual in the same round is skipped here, not refused.
      UPDATE public.competitions c SET leg_order_enabled = (e.value)::text::boolean
        FROM jsonb_each(p_value->'leg_order') AS e
       WHERE c.category_id = e.key::uuid AND c.event_id = p_event_id AND c.kind = 'team';
    END IF;

  ELSIF p_section = 'payments' THEN
    -- The payment window only. The payout account is not a section: it is
    -- written by save_event_payout (update-event-payout, club owner only).
    UPDATE public.registration_settings SET
      payment_window_hours = CASE WHEN p_value ? 'payment_window_hours'
                                  THEN (p_value->>'payment_window_hours')::integer ELSE payment_window_hours END,
      payment_window_until_close = CASE WHEN p_value ? 'payment_window_until_close'
                                        THEN (p_value->'payment_window_until_close')::text::boolean
                                        ELSE payment_window_until_close END,
      -- „Przekazanie pakietu” (ruling 4; the validator keeps transfer_until ≤ event_date − 1).
      transfer_enabled = CASE WHEN p_value ? 'transfer_enabled'
                              THEN (p_value->'transfer_enabled')::text::boolean ELSE transfer_enabled END,
      transfer_until   = CASE WHEN p_value ? 'transfer_until'
                              THEN (p_value->>'transfer_until')::date ELSE transfer_until END
    WHERE event_id = p_event_id;

  ELSIF p_section = 'extras' THEN
    -- Dodatki: the whole list. Every id must be this event's: an extra, a variant of that very
    -- extra, a competition, an image upload of kind 'extra'.
    IF EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x
          WHERE x->>'id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.extras e WHERE e.id = (x->>'id')::uuid AND e.event_id = p_event_id))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
          WHERE v->>'id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.extra_variants ev
                             WHERE ev.id = (v->>'id')::uuid AND ev.extra_id::text IS NOT DISTINCT FROM x->>'id'))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements_text(x->'category_ids') AS c
          WHERE NOT EXISTS (SELECT 1 FROM public.competitions k WHERE k.category_id = c::uuid AND k.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    FOR v_x IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
      IF v_x->>'image_upload_id' IS NOT NULL THEN
        PERFORM public.registration_check_upload(p_event_id, v_x->>'image_upload_id', 'extra');
      END IF;
    END LOOP;

    -- Left out: variants go first (extra_variants.extra_id is RESTRICT), then their extras. A
    -- variant that sold stays (ruling 10): the delete skips it in the writing statement, and one
    -- left behind refuses the whole save.
    DELETE FROM public.extra_variants ev USING public.extras e
     WHERE ev.extra_id = e.id AND e.event_id = p_event_id AND ev.sold = 0
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
                        WHERE (v->>'id')::uuid = ev.id);
    IF EXISTS (
      SELECT 1 FROM public.extra_variants ev JOIN public.extras e ON e.id = ev.extra_id
       WHERE e.event_id = p_event_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
                          WHERE (v->>'id')::uuid = ev.id)) THEN
      RAISE EXCEPTION 'extra_locked';
    END IF;
    DELETE FROM public.extras e
     WHERE e.event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x WHERE (x->>'id')::uuid = e.id);

    FOR v_x, v_n IN SELECT value, ordinality FROM jsonb_array_elements(p_value->'items') WITH ORDINALITY LOOP
      v_extra := (v_x->>'id')::uuid;
      IF v_extra IS NULL THEN
        INSERT INTO public.extras (event_id, name, image_upload_id, price, order_until, sort_order)
        VALUES (p_event_id, v_x->>'name', (v_x->>'image_upload_id')::uuid, (v_x->>'price')::integer,
                (v_x->>'order_until')::date, v_n)
        RETURNING id INTO v_extra;
      ELSE
        -- The price of an extra that sold stays (ruling 10), checked in the writing statement.
        UPDATE public.extras e SET
          name = v_x->>'name', image_upload_id = (v_x->>'image_upload_id')::uuid,
          price = (v_x->>'price')::integer, order_until = (v_x->>'order_until')::date, sort_order = v_n
        WHERE e.id = v_extra
          AND (e.price = (v_x->>'price')::integer
               OR NOT EXISTS (SELECT 1 FROM public.extra_variants ev WHERE ev.extra_id = e.id AND ev.sold > 0));
        IF NOT FOUND THEN
          RAISE EXCEPTION 'extra_locked';
        END IF;
      END IF;
      -- No competition named = every competition.
      DELETE FROM public.extra_competitions ec
       WHERE ec.extra_id = v_extra
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_x->'category_ids') AS c WHERE c::uuid = ec.category_id);
      INSERT INTO public.extra_competitions (extra_id, category_id)
      SELECT v_extra, c::uuid FROM jsonb_array_elements_text(v_x->'category_ids') AS c
      ON CONFLICT DO NOTHING;

      v_vids := '{}';
      FOR v_v, v_m IN SELECT value, ordinality FROM jsonb_array_elements(v_x->'variants') WITH ORDINALITY LOOP
        v_var := (v_v->>'id')::uuid;
        IF v_var IS NULL THEN
          INSERT INTO public.extra_variants (extra_id, label, stock, sort_order)
          VALUES (v_extra, v_v->>'label', (v_v->>'stock')::integer, v_m)
          RETURNING id INTO v_var;
        ELSE
          -- Stock never below what sold: a sale landing meanwhile either commits first and
          -- blocks this, or waits and meets the new stock.
          UPDATE public.extra_variants SET label = v_v->>'label', stock = (v_v->>'stock')::integer, sort_order = v_m
           WHERE id = v_var AND sold <= (v_v->>'stock')::integer;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'extra_locked';
          END IF;
        END IF;
        v_vids := v_vids || v_var;
      END LOOP;
      v_xids := v_xids || v_extra;
      v_nested := v_nested || jsonb_build_array(to_jsonb(v_vids));
    END LOOP;
    v_result := jsonb_build_object('extraIds', to_jsonb(v_xids), 'variantIds', v_nested);

  ELSE
    RAISE EXCEPTION 'unknown_section';
  END IF;

  RETURN v_result;
END $$;
REVOKE EXECUTE ON FUNCTION public.apply_registration_section(uuid, text, jsonb, boolean) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_check_locks (from 20261103110000)

CREATE OR REPLACE FUNCTION public.registration_check_locks(p_event_id uuid, p_section text, p_value jsonb) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_rs   public.registration_settings%ROWTYPE;
  v_item jsonb;
  v_comp public.competitions%ROWTYPE;
  v_mode text;
  v_old  integer;
  v_today    date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_cur      uuid;
  v_cur_ends date;
  v_tiered   boolean;
BEGIN
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_section = 'basics' AND p_value ? 'slug' AND p_value->>'slug' IS DISTINCT FROM v_rs.slug THEN
    RAISE EXCEPTION 'immutable';
  END IF;
  IF p_section = 'timing' AND p_value ? 'timing_mode' AND p_value->>'timing_mode' IS DISTINCT FROM v_rs.timing_mode THEN
    RAISE EXCEPTION 'immutable';
  END IF;
  -- A custom consent somebody accepted stays, word for word (P2-R30). Changed here: and
  -- keeps whom it applies to (minors_only).
  IF p_section = 'form' AND p_value ? 'consents' THEN
    IF EXISTS (
      SELECT 1 FROM public.event_consents ec
       WHERE ec.event_id = p_event_id AND ec.kind = 'custom'
         AND EXISTS (SELECT 1 FROM public.consent_acceptances ca WHERE ca.consent_id = ec.id)
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
                          WHERE k->>'id' = ec.id::text AND k->>'text' = ec.text
                            AND coalesce((k->>'minorsOnly')::boolean, false) = ec.minors_only)) THEN
      RAISE EXCEPTION 'consent_locked';
    END IF;
  END IF;
  -- A pending team has frozen its size and its legs (ruling 5, D5-16).
  IF p_section = 'form' AND p_value ? 'leg_order' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_value->'leg_order') AS k
       WHERE NOT EXISTS (SELECT 1 FROM public.competitions c
                          WHERE c.category_id = k::uuid AND c.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_each(p_value->'leg_order') AS e
        JOIN public.competitions c ON c.category_id = e.key::uuid
       WHERE (e.value)::text::boolean IS DISTINCT FROM c.leg_order_enabled
         AND public.registration_competition_in_use(c.category_id)) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
  END IF;
  -- Ruling 10: an extra with a sold variant keeps its price and stays; a sold variant stays, its
  -- stock at least what sold. publish_registration_changes calls this again with the variants
  -- locked, and apply_registration_section's writing statements check it a third time.
  IF p_section = 'extras' THEN
    -- Staged ids are this event's (apply checks them again, with the images).
    IF EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x
          WHERE x->>'id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.extras e WHERE e.id = (x->>'id')::uuid AND e.event_id = p_event_id))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
          WHERE v->>'id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.extra_variants ev
                             WHERE ev.id = (v->>'id')::uuid AND ev.extra_id::text IS NOT DISTINCT FROM x->>'id'))
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements_text(x->'category_ids') AS c
          WHERE NOT EXISTS (SELECT 1 FROM public.competitions k WHERE k.category_id = c::uuid AND k.event_id = p_event_id)) THEN
      RAISE EXCEPTION 'foreign_id';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.extras e
       WHERE e.event_id = p_event_id
         AND EXISTS (SELECT 1 FROM public.extra_variants ev WHERE ev.extra_id = e.id AND ev.sold > 0)
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x
                          WHERE x->>'id' = e.id::text AND (x->>'price')::integer = e.price)) THEN
      RAISE EXCEPTION 'extra_locked';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.extra_variants ev JOIN public.extras e ON e.id = ev.extra_id
       WHERE e.event_id = p_event_id AND ev.sold > 0
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS x, jsonb_array_elements(x->'variants') AS v
                          WHERE x->>'id' = e.id::text AND v->>'id' = ev.id::text
                            AND (v->>'stock')::integer >= ev.sold)) THEN
      RAISE EXCEPTION 'extra_locked';
    END IF;
    RETURN;
  END IF;
  IF p_section <> 'competitions' THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
     WHERE i->>'category_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.competitions c
                        WHERE c.category_id = (i->>'category_id')::uuid AND c.event_id = p_event_id)) THEN
    RAISE EXCEPTION 'foreign_id';
  END IF;
  -- After publish a competition is hidden, never deleted.
  IF EXISTS (
    SELECT 1 FROM public.competitions c
     WHERE c.event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'items') AS i
                        WHERE (i->>'category_id')::uuid = c.category_id)) THEN
    RAISE EXCEPTION 'competition_locked';
  END IF;

  v_mode := coalesce(p_value->>'pricing_mode', v_rs.pricing_mode);
  IF v_mode IS DISTINCT FROM v_rs.pricing_mode
     AND EXISTS (SELECT 1 FROM public.competitions c
                 WHERE c.event_id = p_event_id AND public.registration_competition_in_use(c.category_id)) THEN
    RAISE EXCEPTION 'price_locked';
  END IF;

  -- Ruling 9, tiered staying tiered, against the Warsaw day of this call (at staging, and again
  -- at „Opublikuj zmiany”, D7-2). Once any competition is in use, the past tiers and the current
  -- one keep their dates and stay; a future tier, new or moved, ends after the current one.
  v_tiered := v_mode = 'tiered' AND v_rs.pricing_mode = 'tiered';
  IF v_tiered THEN
    SELECT t.o_id, t.o_ends_on INTO v_cur, v_cur_ends FROM public.registration_current_tier(p_event_id) t;
    IF EXISTS (SELECT 1 FROM public.competitions c
                WHERE c.event_id = p_event_id AND public.registration_competition_in_use(c.category_id)) THEN
      IF EXISTS (
        SELECT 1 FROM public.price_tiers t
         WHERE t.event_id = p_event_id AND (t.id = v_cur OR t.ends_on < v_today)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'tiers') AS s
                            WHERE s->>'id' = t.id::text AND (s->>'ends_on')::date IS NOT DISTINCT FROM t.ends_on)) THEN
        RAISE EXCEPTION 'price_locked';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_value->'tiers') AS s
         WHERE s->>'ends_on' IS NOT NULL
           AND (v_cur_ends IS NULL OR (s->>'ends_on')::date <= v_cur_ends)
           AND NOT EXISTS (SELECT 1 FROM public.price_tiers t
                            WHERE t.event_id = p_event_id AND t.id::text = s->>'id'
                              AND (t.id = v_cur OR t.ends_on < v_today))) THEN
        RAISE EXCEPTION 'price_locked';
      END IF;
    END IF;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'items') LOOP
    CONTINUE WHEN v_item->>'category_id' IS NULL;
    SELECT * INTO v_comp FROM public.competitions WHERE category_id = (v_item->>'category_id')::uuid;
    CONTINUE WHEN NOT public.registration_competition_in_use(v_comp.category_id);
    IF v_item ? 'kind' AND v_item->>'kind' IS DISTINCT FROM v_comp.kind THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_item ? 'hidden' AND (v_item->>'hidden')::boolean IS DISTINCT FROM (v_comp.hidden_at IS NOT NULL) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF (v_item ? 'team_min' AND (v_item->>'team_min')::integer IS DISTINCT FROM v_comp.team_min)
       OR (v_item ? 'team_max' AND (v_item->>'team_max')::integer IS DISTINCT FROM v_comp.team_max) THEN
      RAISE EXCEPTION 'competition_locked';
    END IF;
    IF v_mode = 'fixed' THEN
      SELECT p.amount INTO v_old
        FROM public.competition_prices p JOIN public.price_tiers t ON t.id = p.tier_id
       WHERE p.category_id = v_comp.category_id AND t.ends_on IS NULL
       ORDER BY t.sort_order LIMIT 1;
      IF (v_item->>'price')::integer IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'price_locked';
      END IF;
    END IF;
    -- Ruling 9: a competition in use keeps the amounts of its past tiers and of the current one.
    IF v_tiered AND EXISTS (
      SELECT 1 FROM public.competition_prices p JOIN public.price_tiers t ON t.id = p.tier_id
       WHERE p.category_id = v_comp.category_id AND (t.id = v_cur OR t.ends_on < v_today)
         AND (v_item->'prices'->>(t.id::text))::integer IS DISTINCT FROM p.amount) THEN
      RAISE EXCEPTION 'price_locked';
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_check_locks(uuid, text, jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_raw (from 20261104200000)

CREATE OR REPLACE FUNCTION public.registration_raw(p_event_id uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  WITH rs AS (
    SELECT * FROM public.registration_settings WHERE event_id = p_event_id
  ),
  tiers AS (
    SELECT t.id, t.ends_on,
           row_number() OVER (ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id) AS n
      FROM public.price_tiers t
     WHERE t.event_id = p_event_id
       AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
  ),
  comps AS (
    SELECT k.*,
           (SELECT count(*) FROM public.registrations r
             WHERE r.category_id = k.category_id AND r.status = 'confirmed')::integer AS confirmed,
           (SELECT p.amount FROM public.competition_prices p JOIN tiers t ON t.id = p.tier_id
             WHERE p.category_id = k.category_id AND t.n = 1) AS current_price,
           (SELECT jsonb_build_object('grosze', p.amount, 'from', to_char(cur.ends_on + 1, 'YYYY-MM-DD'))
              FROM public.competition_prices p
              JOIN tiers nxt ON nxt.id = p.tier_id AND nxt.n = 2
              JOIN tiers cur ON cur.n = 1
             WHERE p.category_id = k.category_id) AS next_price,
           u.path AS gpx_path, u.meta AS gpx_meta
      FROM public.competitions k
      LEFT JOIN public.registration_uploads u
        ON u.id = k.gpx_upload_id AND u.kind = 'gpx' AND u.event_id = k.event_id
     WHERE k.event_id = p_event_id AND k.hidden_at IS NULL
  )
  SELECT jsonb_build_object(
    'eventId', rs.event_id,
    'slug', rs.slug,
    'state', rs.state,
    'club', (SELECT jsonb_build_object('name', c.name) FROM public.clubs c WHERE c.id = rs.club_id),
    'name', rs.name,
    'eventDate', to_char(rs.event_date, 'YYYY-MM-DD'),
    'firstStartTime', to_char(rs.first_start_time, 'HH24:MI'),
    'opensAt', rs.opens_at,
    'closesAt', rs.closes_at,
    'isCharity', rs.is_charity,
    'charityGoal', rs.charity_goal,
    'charityUrl', rs.charity_url,       -- new
    'description', rs.description,      -- new
    'donationsEnabled', rs.donations_enabled,
    'town', jsonb_build_object(
      'label', rs.town_label, 'area', rs.town_area, 'placeDetails', rs.place_details,
      'lat', rs.lat, 'lng', rs.lng),
    'office', jsonb_build_object(
      'sameAsEvent', rs.office_same_as_event, 'address', rs.office_address, 'notes', rs.office_notes,
      'lat', rs.office_lat, 'lng', rs.office_lng,
      'hours', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'date', to_char(h.starts_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD'),
                 'from', to_char(h.starts_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'),
                 'to', to_char(h.ends_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'),
                 'note', h.note)
               ORDER BY h.starts_at, h.ends_at)
          FROM public.office_hours h WHERE h.event_id = rs.event_id), '[]'::jsonb)),
    'timing', jsonb_build_object(
      'mode', rs.timing_mode, 'company', rs.timing_company,
      'resultsUrl', rs.results_url, 'liveResultsUrl', rs.live_results_url),
    'contactEmail', rs.contact_email,
    'regulamin', jsonb_build_object(
      'kind', rs.regulamin_kind,
      'url', CASE WHEN rs.regulamin_kind = 'link' THEN rs.regulamin_url END,
      'path', CASE WHEN rs.regulamin_kind = 'pdf' THEN
                (SELECT u.path FROM public.registration_uploads u
                  WHERE u.id = rs.regulamin_upload_id AND u.kind = 'regulamin' AND u.event_id = rs.event_id) END,
      'version', rs.regulamin_version),
    'posterPath', (SELECT u.path FROM public.registration_uploads u
                    WHERE u.id = rs.poster_upload_id AND u.kind = 'poster' AND u.event_id = rs.event_id),
    'ageReckoning', rs.age_reckoning,
    'formFields', rs.form_fields,
    'pricingMode', rs.pricing_mode,
    'transfer', jsonb_build_object('enabled', rs.transfer_enabled, 'until', to_char(rs.transfer_until, 'YYYY-MM-DD')),
    -- No stock, sold, voucher or partner: only what is left of each variant (0 stays, as „brak”).
    'extras', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id,
               'name', x.name,
               'imagePath', (SELECT u.path FROM public.registration_uploads u
                              WHERE u.id = x.image_upload_id AND u.kind = 'extra' AND u.event_id = x.event_id),
               'price', x.price,
               'orderUntil', to_char(x.order_until, 'YYYY-MM-DD'),
               'categoryIds', coalesce((SELECT jsonb_agg(ec.category_id ORDER BY ec.category_id)
                                          FROM public.extra_competitions ec WHERE ec.extra_id = x.id), '[]'::jsonb),
               'variants', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'label', v.label, 'left', v.stock - v.sold)
                                                      ORDER BY v.sort_order, v.id)
                                       FROM public.extra_variants v WHERE v.extra_id = x.id), '[]'::jsonb))
             ORDER BY x.sort_order, x.id)
        FROM public.extras x WHERE x.event_id = rs.event_id), '[]'::jsonb),
    'consents', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'text', e.text, 'minorsOnly', e.minors_only)
             ORDER BY CASE e.kind WHEN 'regulamin' THEN 0 WHEN 'data_info' THEN 1 ELSE 2 END, e.sort_order, e.created_at, e.id)
        FROM public.event_consents e WHERE e.event_id = rs.event_id), '[]'::jsonb),
    'competitions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'categoryId', k.category_id,
               'name', k.name,
               'kind', k.kind,
               'teamMin', k.team_min,
               'teamMax', k.team_max,
               'legOrderEnabled', k.leg_order_enabled,
               'discipline', k.discipline,
               'distanceLabel', k.distance_label,
               'startTime', to_char(k.start_time, 'HH24:MI'),
               'capacity', k.capacity,
               'taken', k.taken,
               'confirmed', k.confirmed,
               'minAge', k.min_age,
               'maxAge', k.max_age,
               'isKids', k.is_kids,
               'timed', k.timed,
               'priceGrosze', CASE WHEN rs.pricing_mode = 'free' THEN 0 ELSE k.current_price END,
               'nextPrice', CASE WHEN rs.pricing_mode = 'free' THEN NULL ELSE k.next_price END,
               'ageGroups', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('gender', g.gender, 'label', g.label,
                                                     'minAge', g.min_age, 'maxAge', g.max_age)
                        ORDER BY g.gender, g.min_age, g.label)
                   FROM public.age_groups g WHERE g.category_id = k.category_id), '[]'::jsonb),
               'kidsGroups', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('label', g.label, 'birthYearFrom', g.birth_year_from,
                                                     'birthYearTo', g.birth_year_to, 'gender', g.gender,
                                                     'distanceLabel', g.distance_label)
                        ORDER BY g.birth_year_from DESC, g.label)
                   FROM public.kids_groups g WHERE g.category_id = k.category_id), '[]'::jsonb),
               'course', CASE WHEN k.gpx_path IS NULL THEN NULL ELSE jsonb_build_object(
                 'km', k.gpx_meta -> 'km', 'upM', k.gpx_meta -> 'upM', 'downM', k.gpx_meta -> 'downM',
                 'points', k.gpx_meta -> 'points', 'profile', coalesce(k.gpx_meta -> 'profile', '[]'::jsonb),
                 'gpxPath', k.gpx_path) END)
             ORDER BY k.sort_order, k.category_id)
        FROM comps k), '[]'::jsonb)
  )
  FROM rs
$$;
REVOKE EXECUTE ON FUNCTION public.registration_raw(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_raw(uuid) TO service_role;
