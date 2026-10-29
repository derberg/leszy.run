-- Race registration, plan 4 task 3: consent requests. An adult registered by someone
-- else (role 'adult', consent_state 'awaiting') gets a link with a single-use token; the
-- table keeps only its SHA-256 (_shared/registration/tokens.js).
--
--   consent_requests                    one per registration: token_hash, sent_at,
--                                       last_reminded_at (manual reminders), auto_reminded_at
--                                       (the one automatic reminder, D4-24), used_at, expires_at
--   issue_consent_request(reg, hash)    true once; false when already issued or the
--                                       registration is not confirmed + awaiting
--   rotate_consent_request(reg, hash)   a reminder: the old link dies, the new hash is valid
--   accept_consent_request(hash, profile, edits, meta)
--                                       { status: accepted | invalid | expired }; raises gone,
--                                       profile_mismatch, consents_changed, edits_closed,
--                                       edit_invalid (a raise rolls the token back to unused)
--   mark_consent_office(reg, actor)     the organizer's „Podpisany w biurze”
--   claim_consent_reminders(limit)      the automatic reminder 72 h before closes_at, claimed
--                                       at most once per request (registration-jobs sends it)
--   registration_age_on(birth, on, reckoning)   ageOn() of ageGroups.js, internal
--   purge_registration_contact_data()   D4-30: also clears guardian_name / guardian_email
--
-- Lock order: the registrations row first, then consent_requests, in every function that
-- touches both (accept, office, issue). rotate and claim lock consent_requests only. The
-- settings row is read without a lock (D3-1 puts settings before registrations, so taking
-- it after the registration lock could deadlock against publish_registration_changes).

-- ---------------------------------------------------------------- table

CREATE TABLE public.consent_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  uuid NOT NULL UNIQUE REFERENCES public.registrations(id) ON DELETE RESTRICT,
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  last_reminded_at timestamptz,
  auto_reminded_at timestamptz,
  used_at          timestamptz,
  expires_at       timestamptz NOT NULL
);

ALTER TABLE public.consent_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.consent_requests FROM anon, authenticated;

-- ---------------------------------------------------------------- age helper

-- ageOn() of _shared/registration/ageGroups.js: 'race_day' counts the birthday reached on
-- p_on (a 29 February birthday from 1 March in other years), 'year_end' by 31 December.
CREATE FUNCTION public.registration_age_on(p_birth date, p_on date, p_reckoning text) RETURNS integer
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT CASE WHEN p_reckoning = 'year_end'
              THEN extract(year FROM p_on)::integer - extract(year FROM p_birth)::integer
              ELSE extract(year FROM p_on)::integer - extract(year FROM p_birth)::integer
                   - CASE WHEN (extract(month FROM p_on), extract(day FROM p_on))
                               < (extract(month FROM p_birth), extract(day FROM p_birth))
                          THEN 1 ELSE 0 END
         END
$$;
REVOKE EXECUTE ON FUNCTION public.registration_age_on(date, date, text) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- issue

CREATE FUNCTION public.issue_consent_request(p_registration_id uuid, p_token_hash text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r       public.registrations%ROWTYPE;
  v_date  date;
  v_close timestamptz;
  v_id    uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_token_hash';
  END IF;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'confirmed' OR r.consent_state <> 'awaiting' THEN
    RETURN false;
  END IF;
  SELECT rs.event_date, rs.closes_at INTO v_date, v_close
    FROM public.registration_settings rs WHERE rs.event_id = r.event_id;

  -- The link lives until the race day is over: midnight Warsaw after event_date.
  INSERT INTO public.consent_requests (registration_id, token_hash, expires_at)
  VALUES (p_registration_id, p_token_hash,
          coalesce(((v_date + 1)::timestamp AT TIME ZONE 'Europe/Warsaw'), v_close))
  ON CONFLICT (registration_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.issue_consent_request(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_consent_request(uuid, text) TO service_role;

-- ---------------------------------------------------------------- rotate

-- Every reminder (manual or automatic) rotates the token. False when the request is spent,
-- expired, missing, or its registration is no longer confirmed + awaiting.
CREATE FUNCTION public.rotate_consent_request(p_registration_id uuid, p_token_hash text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_token_hash';
  END IF;
  UPDATE public.consent_requests cr
     SET token_hash = p_token_hash, last_reminded_at = now()
   WHERE cr.registration_id = p_registration_id
     AND cr.used_at IS NULL
     AND cr.expires_at > now()
     AND EXISTS (SELECT 1 FROM public.registrations r
                  WHERE r.id = cr.registration_id AND r.status = 'confirmed' AND r.consent_state = 'awaiting')
  RETURNING cr.id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.rotate_consent_request(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_consent_request(uuid, text) TO service_role;

-- ---------------------------------------------------------------- accept

-- p_edits (ruling 6): firstName, lastName, phone, city, club, iceName, icePhone, nationality,
-- birthDate, gender; strings or null. The email is never editable; an unknown key is
-- edit_invalid. Only values that differ from the stored ones count as edits, so a form
-- that sends its unchanged fields back after closes_at is not refused. Field shapes here
-- are the backstop: the edge function runs validatePerson first and words the messages.
CREATE FUNCTION public.accept_consent_request(p_token_hash text, p_profile_id uuid, p_edits jsonb, p_meta jsonb)
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

  -- The registration first (lock order), found through the hash without a lock.
  SELECT cr.registration_id INTO v_reg_id FROM public.consent_requests cr WHERE cr.token_hash = p_token_hash;
  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
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

  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = r.category_id;

  -- D4-5: exactly the consents the page showed, image included.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = r.event_id;
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
    FROM public.event_consents ec WHERE ec.event_id = r.event_id
  UNION ALL
  SELECT r.id, NULL, 'service_regulamin', p_profile_id, 'self', NULL, v_ip, v_ua;

  RETURN jsonb_build_object('status', 'accepted', 'registrationId', r.id, 'eventId', r.event_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.accept_consent_request(text, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_consent_request(text, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------- office

-- „Podpisany w biurze”: the person signed the event's terms on paper. The acceptances are
-- the event consents only, recorded as 'office' by the organizer: the person never used
-- the service, so no service_regulamin acceptance is invented for them.
CREATE FUNCTION public.mark_consent_office(p_registration_id uuid, p_actor uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_event   uuid;
  v_version integer;
BEGIN
  PERFORM 1 FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  UPDATE public.registrations SET consent_state = 'office'
   WHERE id = p_registration_id AND consent_state = 'awaiting' AND status = 'confirmed'
  RETURNING event_id INTO v_event;
  IF v_event IS NULL THEN
    RETURN false;
  END IF;

  SELECT rs.regulamin_version INTO v_version FROM public.registration_settings rs WHERE rs.event_id = v_event;
  INSERT INTO public.consent_acceptances (
    registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
  SELECT p_registration_id, ec.id, ec.kind, p_actor, 'office',
         CASE WHEN ec.kind = 'regulamin' THEN v_version END, NULL, NULL
    FROM public.event_consents ec WHERE ec.event_id = v_event;

  UPDATE public.consent_requests SET used_at = now()
   WHERE registration_id = p_registration_id AND used_at IS NULL;
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION public.mark_consent_office(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_consent_office(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------- automatic reminder

-- D4-24 / D4-31: one automatic reminder per request, ever, in the 72 h before closes_at,
-- and never within 24 h of the first e-mail or a manual reminder. One statement claims:
-- SKIP LOCKED lets two parallel runs split the rows instead of both taking them.
CREATE FUNCTION public.claim_consent_reminders(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  UPDATE public.consent_requests cr
     SET auto_reminded_at = now()
   WHERE cr.id IN (
           SELECT c.id
             FROM public.consent_requests c
             JOIN public.registrations r ON r.id = c.registration_id
             JOIN public.registration_settings rs ON rs.event_id = r.event_id
            WHERE c.auto_reminded_at IS NULL
              AND c.used_at IS NULL
              AND c.expires_at > now()
              AND r.status = 'confirmed'
              AND r.consent_state = 'awaiting'
              AND rs.closes_at - interval '72 hours' <= now()
              AND now() < rs.closes_at
              AND coalesce(c.last_reminded_at, c.sent_at) <= now() - interval '24 hours'
            ORDER BY rs.closes_at, c.id
            LIMIT greatest(coalesce(p_limit, 50), 0)
              FOR UPDATE OF c SKIP LOCKED)
     AND cr.auto_reminded_at IS NULL
  RETURNING cr.registration_id
$$;
REVOKE EXECUTE ON FUNCTION public.claim_consent_reminders(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_consent_reminders(integer) TO service_role;

-- ---------------------------------------------------------------- contact purge (D4-30)

-- Replaced from 20261029200000: a child's guardian name and address are contact data
-- like the phone and ICE, so they go 30 days after the event too. guardian_profile_id
-- stays: it is the link that puts the child's entry in the guardian's own export.
CREATE OR REPLACE FUNCTION public.purge_registration_contact_data() RETURNS integer
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
     SET phone = NULL, ice_name = NULL, ice_phone = NULL, guardian_name = NULL, guardian_email = NULL
    FROM public.registration_settings rs
   WHERE rs.event_id = r.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND (r.phone IS NOT NULL OR r.ice_name IS NOT NULL OR r.ice_phone IS NOT NULL
          OR r.guardian_name IS NOT NULL OR r.guardian_email IS NOT NULL);
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
