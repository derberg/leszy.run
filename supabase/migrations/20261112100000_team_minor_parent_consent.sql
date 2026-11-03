-- A child in a relay team whose parent is not the captain. The captain of a relay is often a coach,
-- yet every child member was stored with the captain as guardian and the captain's acceptances as
-- the guardian's. On a child's card the captain now either declares to be the parent or legal
-- guardian (as before) or names the parent: first and last name and e-mail, sent as the person's
-- `guardian` { name, email } (validateTeam / validateSquadMember in _shared/registration/team.js).
--
-- Such a child is stored with guardian_name / guardian_email = the parent, guardian_profile_id NULL,
-- guardian_named true and consent_state 'awaiting'; no acceptance is written for them. The consent request (Plan 4) goes
-- to guardian_email (consentRecipient in group.js), and on /zgoda the parent, signed in at that
-- address, accepts every event consent, the minors-only ones included, as 'guardian':
-- accept_consent_request sets guardian_profile_id to the parent's account. The organizer's
-- „Podpisany w biurze” (mark_consent_office) covers a child the same way, minors-only consents
-- included, recorded as 'office' by the organizer like an adult's. Nothing removes a child whose
-- parent never answers: the entry stays, flagged as awaiting, for the office.
--
-- registrations.guardian_named (new, default false) says the guardian is a parent the registrant
-- named. It is what keeps such a row a child's once the 30-day purge has nulled guardian_name and
-- guardian_email and no guardian_profile_id exists (the parent never accepted, or signed on paper):
-- registrationRole (group.js) and the child rule of the functions below read it beside the guardian
-- fields. guardian_removed_at keeps its one meaning, the guardian deleted the account (D4-25). The
-- column holds no personal data, so neither the purge nor delete-my-account touches it.
--
-- Every function here is recreated from its latest body and changed only where marked:
--   * registration_group_lock (20261105090000): minors_only consents are required only for a child
--     the payer answers for.
--   * registration_group_insert (20261105090000): the `guardian` path.
--   * team_squad_insert (20261101120000): a child with a named parent carries no consents.
--   * accept_consent_request, mark_consent_office (20261105090000): a child's entry.
--   * consent_requests_missing (20261031115000): a child's request goes to guardian_email.
-- rotate_consent_request, claim_consent_reminders and claim_consent_resends read consent_state and
-- the request only, so the reminders already cover these children. CREATE OR REPLACE keeps every
-- grant; the REVOKE / GRANT after each function restates it.

ALTER TABLE public.registrations ADD COLUMN guardian_named boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- registration_group_lock (from 20261105090000)

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
  -- A minors_only consent is shown, so required, only when a person is a minor.
  -- Changed here: and only for a minor the payer answers for. A child carrying `guardian` (a
  -- team member whose parent is not the captain) is accepted for by that parent on /zgoda.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec
   WHERE ec.event_id = o_settings.event_id
     AND (NOT ec.minors_only
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_people) AS e
                      WHERE e->>'role' = 'minor' AND jsonb_typeof(e->'guardian') IS DISTINCT FROM 'object'));
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_lock(jsonb, jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_group_insert (from 20261105090000)

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
  -- Changed here: a child whose parent is not the payer (`guardian` { name, email }, set by
  -- validateTeam / validateSquadMember only).
  -- Never NULL: a person with no `guardian` key is false, so every other path writes what it did.
  v_named boolean := coalesce(p_person->>'role' = 'minor' AND jsonb_typeof(p_person->'guardian') = 'object', false);
  v_gname text := nullif(btrim(p_person->'guardian'->>'name'), '');
  v_gmail text := lower(btrim(p_person->'guardian'->>'email'));
BEGIN
  -- The parent's name and address, and never the payer's own: then the payer is the guardian.
  IF v_named AND (v_gname IS NULL OR length(v_gname) > 201
                  OR v_gmail IS NULL OR v_gmail !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' OR length(v_gmail) > 254
                  OR v_gmail = lower(btrim(p_buyer_email))) THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  BEGIN
    INSERT INTO public.registrations (
      event_id, category_id, order_id, status, profile_id, registered_by_profile_id,
      first_name, last_name, birth_date, gender, email,
      phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id,
      guardian_profile_id, guardian_name, guardian_email, guardian_named, consent_state, list_price, price, voucher_id, partner_id)
    VALUES (
      p_rs.event_id, (p_person->>'categoryId')::uuid, p_order_id, p_status,
      -- The account is this person's only when its address is theirs.
      CASE WHEN v_email IS NOT NULL
           THEN (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email) END,
      p_profile_id,
      p_person->>'firstName', p_person->>'lastName', (p_person->>'birthDate')::date, p_person->>'gender', v_email,
      p_person->>'phone', p_person->>'city', p_person->>'club', p_person->>'iceName', p_person->>'icePhone',
      nullif(p_person->>'nationality', ''), p_person->>'ageGroupLabel', nullif(p_person->>'kidsGroupId', '')::uuid,
      -- Changed here: a named parent is the guardian, with no account until they accept, and the
      -- child waits for them as an added adult waits for themself.
      CASE WHEN v_role = 'minor' AND NOT v_named THEN p_profile_id END,
      CASE WHEN v_named THEN v_gname WHEN v_role = 'minor' THEN p_buyer_name END,
      CASE WHEN v_named THEN v_gmail WHEN v_role = 'minor' THEN p_buyer_email END,
      v_named,
      CASE WHEN v_role = 'adult' OR v_named THEN 'awaiting' ELSE 'accepted' END,
      coalesce(p_list_price, p_price), p_price, p_voucher_id, p_partner_id)
    RETURNING id INTO v_reg;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'duplicate:%', p_index;
  END;

  -- An added adult accepts for themself later (consent request, task 3). The buyer accepts
  -- for themself, and as guardian for every child, the LESZY.RUN service regulamin included.
  -- A minors_only consent is the guardian's, accepted for a child only.
  -- Changed here: never for a child whose named parent accepts on /zgoda (accept_consent_request).
  IF v_role = 'self' OR (v_role = 'minor' AND NOT v_named) THEN
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

-- ---------------------------------------------------------------- team_squad_insert (from 20261101120000)

CREATE OR REPLACE FUNCTION public.team_squad_insert(p_rs public.registration_settings, p_captain public.registrations,
                                         p_person jsonb, p_leg integer, p_position integer, p_actor uuid, p_meta jsonb)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_role  text := CASE WHEN jsonb_typeof(p_person) = 'object' THEN p_person->>'role' END;
  v_email text;
  v_name  text;
  v_ip    inet;
  v_ua    text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_sent  uuid[];
  v_have  uuid[];
  v_reg   uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('adult', 'minor')
     OR nullif(btrim(p_person->>'firstName'), '') IS NULL OR nullif(btrim(p_person->>'lastName'), '') IS NULL
     OR (v_role = 'adult' AND nullif(btrim(p_person->>'email'), '') IS NULL)
     OR (v_role = 'minor' AND nullif(p_person->>'birthDate', '') IS NULL) THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  -- Changed here: a child whose parent is named carries no acceptances of the captain's.
  IF v_role = 'minor' AND jsonb_typeof(p_person->'guardian') IS DISTINCT FROM 'object' THEN
    IF jsonb_typeof(coalesce(p_meta->'consentIds', '[]'::jsonb)) <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(e)
                   WHERE jsonb_typeof(e) <> 'string'
                      OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
    SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
      FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
    SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
      FROM public.event_consents ec WHERE ec.event_id = p_rs.event_id;
    IF v_sent IS DISTINCT FROM v_have THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
  END IF;

  SELECT lower(btrim(p.email)) INTO v_email FROM public.profiles p WHERE p.id = p_actor;
  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     btrim(concat_ws(' ', p_captain.first_name, p_captain.last_name)));
  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  BEGIN
    v_reg := public.registration_group_insert(
      p_rs, p_person || jsonb_build_object('categoryId', p_captain.category_id), 0, p_actor, v_email, v_name,
      p_captain.order_id, p_captain.status, 0, v_ip, v_ua);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'duplicate:%' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    RAISE;
  END;

  UPDATE public.registrations SET team_id = p_captain.team_id, team_leg = p_leg, team_position = p_position WHERE id = v_reg;
  IF p_captain.status = 'confirmed' THEN
    PERFORM public.insert_registration_participant(v_reg);
  END IF;
  RETURN v_reg;
END $$;
REVOKE EXECUTE ON FUNCTION public.team_squad_insert(public.registration_settings, public.registrations, jsonb, integer, integer, uuid, jsonb)
  FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- accept_consent_request (from 20261105090000)

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
  -- Changed here: a child's entry, accepted by the guardian at the guardian's address.
  v_child   boolean;
  v_to      text;
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
  -- Changed here: registrationRole's rule names a child (guardian_named included); the link went to
  -- the guardian's address.
  v_child := r.guardian_named OR r.guardian_name IS NOT NULL OR r.guardian_profile_id IS NOT NULL OR r.guardian_removed_at IS NOT NULL;
  v_to := CASE WHEN v_child THEN r.guardian_email ELSE r.email END;
  IF p_profile_id IS NULL OR v_to IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.id = p_profile_id AND lower(btrim(p.email)) = lower(btrim(v_to))) THEN
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
  -- An adult accepts for themself, so no minors_only consent. Changed here: a guardian accepts
  -- every consent for the child.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = r.event_id AND (v_child OR NOT ec.minors_only);
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
    -- Changed here: a child stays a child, whose guardian is the one accepting.
    v_label := r.age_group_label;
    v_kids := r.kids_group_id;
    IF v_birth IS DISTINCT FROM r.birth_date OR v_gender IS DISTINCT FROM r.gender THEN
      IF v_birth IS NULL OR v_gender IS NULL OR v_birth < DATE '1900-01-01' OR v_birth > v_today THEN
        RAISE EXCEPTION 'edit_invalid';
      END IF;
      IF (public.registration_age_on(v_birth, v_today, 'race_day') < 18) IS DISTINCT FROM v_child THEN
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
     SET consent_state = 'accepted',
         -- Changed here: the guardian's account becomes the child's guardian, never the child's own.
         profile_id = CASE WHEN v_child THEN profile_id ELSE p_profile_id END,
         guardian_profile_id = CASE WHEN v_child THEN p_profile_id ELSE guardian_profile_id END,
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
  SELECT r.id, ec.id, ec.kind, p_profile_id, CASE WHEN v_child THEN 'guardian' ELSE 'self' END,
         CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
    FROM public.event_consents ec WHERE ec.event_id = r.event_id AND (v_child OR NOT ec.minors_only)
  UNION ALL
  SELECT r.id, NULL, 'service_regulamin', p_profile_id, CASE WHEN v_child THEN 'guardian' ELSE 'self' END, NULL, v_ip, v_ua;

  RETURN jsonb_build_object('status', 'accepted', 'registrationId', r.id, 'eventId', r.event_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.accept_consent_request(text, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_consent_request(text, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------- mark_consent_office (from 20261105090000)

CREATE OR REPLACE FUNCTION public.mark_consent_office(p_registration_id uuid, p_actor uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_event   uuid;
  v_done    uuid;
  v_version integer;
  v_child   boolean;
BEGIN
  -- Lock order: settings FOR SHARE, then the registration (as accept_consent_request).
  -- Changed here: a child's paper consent is the guardian's, so it covers the minors_only consents.
  SELECT event_id, guardian_named OR guardian_name IS NOT NULL OR guardian_profile_id IS NOT NULL OR guardian_removed_at IS NOT NULL
    INTO v_event, v_child FROM public.registrations WHERE id = p_registration_id;
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
    FROM public.event_consents ec WHERE ec.event_id = v_event AND (v_child OR NOT ec.minors_only);

  UPDATE public.consent_requests SET used_at = now()
   WHERE registration_id = p_registration_id AND used_at IS NULL;
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION public.mark_consent_office(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_consent_office(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------- consent_requests_missing (from 20261031115000)

CREATE OR REPLACE FUNCTION public.consent_requests_missing(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT r.id
    FROM public.registrations r
    JOIN public.registration_settings rs ON rs.event_id = r.event_id
    LEFT JOIN public.consent_issue_failures f ON f.registration_id = r.id
   WHERE r.status = 'confirmed'
     AND r.consent_state = 'awaiting'
     -- Changed here: a child's request goes to the guardian's address.
     AND coalesce(r.email, r.guardian_email) IS NOT NULL
     AND (rs.event_date IS NULL OR rs.event_date >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
     AND NOT EXISTS (SELECT 1 FROM public.consent_requests c WHERE c.registration_id = r.id)
   ORDER BY coalesce(f.failures, 0) >= 3, r.created_at, r.id
   LIMIT greatest(coalesce(p_limit, 50), 0)
$$;
REVOKE EXECUTE ON FUNCTION public.consent_requests_missing(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consent_requests_missing(integer) TO service_role;
