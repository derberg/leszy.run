-- Competition change, task 3: the core RPCs.
--
-- change_competition moves a live individual entry to another competition of the same event:
--   difference 0  → the entry moves now (registration_move_entry);
--   difference <0 → it moves now and an organizer refund of the difference is reserved
--                   (reserve_organizer_refund, reason 'competition_change'); an order paid outside
--                   LESZY.RUN moves only with the club's acknowledgement and books the difference
--                   as refunded with no refunds row;
--   difference >0 → a pending surcharge order (orders.kind = 'surcharge') for the difference; the
--                   entry does not move until confirm_order confirms it (task 4).
-- cancel_surcharge cancels a pending surcharge and touches nothing else.
--
-- Money model of an entry: registrations.price is everything ever paid for it, refunded everything
-- ever refunded, list_price the current competition's tier price. After any move
-- price − refunded = the new price. The entry keeps its voucher_id on every move: no use is
-- claimed or released, even when the target drops the discount or is free.
--
-- Lock order (CLAUDE.md, Plan 7 list): orders → payment_attempts → order_lines → competitions (by
-- category_id) → registration_settings → registrations → participants; transfers are only read.
-- reserve_organizer_refund, called last, re-locks rows already held and nothing else.
--
-- Also recreated:
--   * organizer_edit_registration, from 20261111220000_organizer_edit_member_without_phone.sql,
--     with its age block moved into registration_competition_placement (same behaviour);
--   * reserve_organizer_refund, from 20261113100000_refund_one_at_a_time.sql, changed only where
--     marked: a 'surcharge' line's reservation adds to registrations.refunded like an entry line's.

-- ---------------------------------------------------------------- registration_competition_placement

-- Where a person fits in a competition: refuses an age outside min_age / max_age (ineligible) and a
-- birth date that turns an adult's entry into a child's or back (role_change), and returns the age
-- group label (else '<gender> open') and the kids group (only for a kids competition). The rules of
-- organizer_edit_registration, which now calls it. Internal.
CREATE FUNCTION public.registration_competition_placement(
  p_category_id uuid, p_birth date, p_gender text, p_email_is_null boolean, p_event_date date, p_reckoning text,
  OUT o_age_group_label text, OUT o_kids_group_id uuid)
  LANGUAGE plpgsql
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_comp  public.competitions%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_age   integer;
BEGIN
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id;
  v_age := public.registration_age_on(p_birth, coalesce(p_event_date, v_today), p_reckoning);
  IF (v_comp.min_age IS NOT NULL AND v_age < v_comp.min_age) OR (v_comp.max_age IS NOT NULL AND v_age > v_comp.max_age) THEN
    RAISE EXCEPTION 'ineligible';
  END IF;
  -- A child's entry has no e-mail and a guardian; an adult's has an e-mail. The role follows them.
  -- A minor is under 18 on race day (Warsaw), as everywhere in registration, never today.
  IF (public.registration_age_on(p_birth, coalesce(p_event_date, v_today), 'race_day') < 18) <> p_email_is_null THEN
    RAISE EXCEPTION 'role_change';
  END IF;
  SELECT coalesce((SELECT g.label FROM public.age_groups g
                    WHERE g.category_id = p_category_id AND g.gender = p_gender
                      AND v_age >= g.min_age AND (g.max_age IS NULL OR v_age <= g.max_age)
                    ORDER BY g.min_age, g.id LIMIT 1),
                  p_gender || ' open')
    INTO o_age_group_label;
  o_kids_group_id := NULL;
  IF v_comp.is_kids THEN
    SELECT k.id INTO o_kids_group_id FROM public.kids_groups k
     WHERE k.category_id = p_category_id
       AND extract(year FROM p_birth)::integer BETWEEN k.birth_year_from AND k.birth_year_to
       AND (k.gender IS NULL OR k.gender = p_gender)
     ORDER BY k.birth_year_from, k.id LIMIT 1;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_competition_placement(uuid, date, text, boolean, date, text)
  FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- organizer_edit_registration

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
  v_pkids   uuid;
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
    -- Changed here: the age rules live in registration_competition_placement (shared with a
    -- competition change). A kids group is re-derived only in a kids competition, as before.
    SELECT p.o_age_group_label, p.o_kids_group_id INTO v_label, v_pkids
      FROM public.registration_competition_placement(r.category_id, v_birth, v_gender, r.email IS NULL,
                                                     v_rs.event_date, v_rs.age_reckoning) p;
    IF v_comp.is_kids THEN
      v_kids := v_pkids;
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

-- ---------------------------------------------------------------- reserve_organizer_refund

CREATE OR REPLACE FUNCTION public.reserve_organizer_refund(p_line_id uuid, p_grosze integer, p_actor uuid, p_request_key text,
                                                p_registration_id uuid DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  f      public.refunds%ROWTYPE;
  l      public.order_lines%ROWTYPE;
  o      public.orders%ROWTYPE;
  a      public.payment_attempts%ROWTYPE;
  v_date date;
  v_left integer;
  v_id   uuid := gen_random_uuid();
  v_msg  text := left(replace(v_id::text, '-', ''), 24);
BEGIN
  IF p_grosze IS NULL OR p_grosze <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  IF p_request_key IS NOT NULL AND (char_length(p_request_key) NOT BETWEEN 8 AND 100) THEN
    RAISE EXCEPTION 'invalid_request_key';
  END IF;
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = l.order_id FOR UPDATE;
  -- Under the order lock, so a concurrent request with the same key sees the committed row.
  IF p_request_key IS NOT NULL THEN
    SELECT * INTO f FROM public.refunds WHERE request_key = p_request_key;
    IF FOUND THEN
      IF f.order_line_id IS DISTINCT FROM p_line_id OR f.amount <> p_grosze THEN
        RAISE EXCEPTION 'request_key_mismatch';
      END IF;
      RETURN jsonb_build_object('refundId', f.id, 'messageId', f.message_id, 'replay', true, 'status', f.dpay_status,
        'requestedAt', f.requested_at, 'respondedAt', f.responded_at,
        'transactionId', (SELECT pa.dpay_transaction_id FROM public.payment_attempts pa WHERE pa.id = f.payment_attempt_id));
    END IF;
  END IF;

  IF o.status <> 'paid' OR o.paid_transaction_id IS NULL THEN
    RAISE EXCEPTION 'not_paid';
  END IF;
  SELECT rs.event_date INTO v_date FROM public.registration_settings rs WHERE rs.event_id = o.event_id;
  IF v_date IS NULL OR now() >= public.registration_refund_cutoff(v_date) THEN
    RAISE EXCEPTION 'race_day';
  END IF;
  SELECT * INTO a FROM public.payment_attempts
   WHERE order_id = o.id AND dpay_transaction_id = o.paid_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_paid';
  END IF;
  -- dpay (2026-11-03): refunds of one transaction go one at a time (see 20261113100000).
  IF EXISTS (SELECT 1 FROM public.refunds r
              WHERE r.payment_attempt_id = a.id
                AND ((r.dpay_status = 'pending' AND r.responded_at IS NULL
                      AND coalesce(r.requested_at, r.created_at) > now() - interval '15 minutes')
                     OR (r.dpay_status = 'unknown' AND r.requested_at > now() - interval '15 minutes'))) THEN
    RAISE EXCEPTION 'refund_in_progress';
  END IF;

  -- Both caps: the line's and record_refund's per attempt.
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id FOR UPDATE;
  -- V-89: the line is read again under the order lock, which apply_transfer also holds while it
  -- moves the line to the new holder. A dialog opened on the old holder's row is refused.
  IF p_registration_id IS NOT NULL AND l.registration_id IS DISTINCT FROM p_registration_id THEN
    RAISE EXCEPTION 'entry_changed';
  END IF;
  v_left := least(l.amount - l.refunded, a.grosze - public.registration_attempt_refunds_held(a.id));
  IF p_grosze > v_left THEN
    RAISE EXCEPTION 'exceeds:%', greatest(v_left, 0);
  END IF;
  UPDATE public.order_lines SET refunded = refunded + p_grosze
   WHERE id = p_line_id AND refunded + p_grosze <= amount;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exceeds:%', greatest(l.amount - l.refunded, 0);
  END IF;
  -- Changed here: a paid surcharge is part of the entry's price, so its refund is the entry's too.
  IF l.kind IN ('entry', 'surcharge') THEN
    UPDATE public.registrations SET refunded = refunded + p_grosze WHERE id = l.registration_id;
  END IF;

  BEGIN
    INSERT INTO public.refunds (id, order_id, payment_attempt_id, order_line_id, amount, kind, reason,
                                requested_by, message_id, request_key)
    VALUES (v_id, o.id, a.id, l.id, p_grosze, 'organizer', 'organizer', p_actor, v_msg, p_request_key);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'request_key_mismatch';
  END;
  RETURN jsonb_build_object('refundId', v_id, 'messageId', v_msg, 'transactionId', a.dpay_transaction_id,
                            'replay', false, 'status', 'pending', 'requestedAt', NULL, 'respondedAt', NULL);
END $$;

REVOKE EXECUTE ON FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------- registration_move_entry

-- Moves a confirmed entry to p_to: one slot claimed in the target (full when there is none), one
-- released in the old competition, the age group and kids group re-derived for the target (ineligible
-- / role_change as organizer_edit_registration), and the participant's category_id (the host pulls it).
-- Money and list_price are the caller's. The caller holds the competitions (category_id order), the
-- settings and the registration. Internal.
CREATE FUNCTION public.registration_move_entry(p_registration_id uuid, p_to uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  r       public.registrations%ROWTYPE;
  v_rs    public.registration_settings%ROWTYPE;
  v_label text;
  v_kids  uuid;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- Only a confirmed entry holds a slot (P3-R15).
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_live';
  END IF;
  IF r.category_id = p_to THEN
    RAISE EXCEPTION 'same_competition';
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id;
  SELECT p.o_age_group_label, p.o_kids_group_id INTO v_label, v_kids
    FROM public.registration_competition_placement(p_to, r.birth_date, r.gender, r.email IS NULL,
                                                   v_rs.event_date, v_rs.age_reckoning) p;
  IF public.claim_competition_slots(p_to, 1) IS NULL THEN
    RAISE EXCEPTION 'full';
  END IF;
  UPDATE public.competitions SET taken = taken - 1 WHERE category_id = r.category_id;
  UPDATE public.registrations
     SET category_id = p_to, age_group_label = v_label, kids_group_id = v_kids
   WHERE id = r.id;
  IF r.participant_id IS NOT NULL THEN
    UPDATE public.participants SET category_id = p_to, updated_at = now() WHERE id = r.participant_id;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_move_entry(uuid, uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_surcharge_buyer

-- Who pays a surcharge (user decision 2026-11-24): the original order's payer while their account
-- exists; else the account of whoever the entry belongs to (a child's guardian, else the runner);
-- else that person's e-mail alone, with no account (the order page has them sign in with a code
-- for it first, task 8). An account deleted softly (profiles.deleted_at) counts as gone. Internal.
CREATE FUNCTION public.registration_surcharge_buyer(p_registration_id uuid)
  RETURNS TABLE (profile_id uuid, email text, name text)
  LANGUAGE plpgsql
  STABLE
  SET search_path = ''
AS $$
DECLARE
  r       public.registrations%ROWTYPE;
  o       public.orders%ROWTYPE;
  v_email text;
  v_child boolean;
BEGIN
  SELECT * INTO r FROM public.registrations x WHERE x.id = p_registration_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF r.order_id IS NOT NULL THEN
    SELECT * INTO o FROM public.orders x WHERE x.id = r.order_id;
    IF o.buyer_profile_id IS NOT NULL THEN
      SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = o.buyer_profile_id AND p.deleted_at IS NULL;
      IF FOUND AND coalesce(o.buyer_email, v_email) IS NOT NULL THEN
        profile_id := o.buyer_profile_id;
        email := coalesce(o.buyer_email, v_email);
        name := o.buyer_name;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  v_child := r.email IS NULL;
  v_email := NULL;
  IF v_child AND r.guardian_profile_id IS NOT NULL THEN
    SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = r.guardian_profile_id AND p.deleted_at IS NULL;
    IF v_email IS NOT NULL THEN
      profile_id := r.guardian_profile_id;
      email := v_email;
      name := r.guardian_name;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSIF NOT v_child AND r.profile_id IS NOT NULL THEN
    SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = r.profile_id AND p.deleted_at IS NULL;
    IF v_email IS NOT NULL THEN
      profile_id := r.profile_id;
      email := v_email;
      name := nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), '');
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  profile_id := NULL;
  email := CASE WHEN v_child THEN r.guardian_email ELSE r.email END;
  name := CASE WHEN v_child THEN r.guardian_name ELSE nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), '') END;
  RETURN NEXT;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_surcharge_buyer(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- change_competition

CREATE FUNCTION public.change_competition(p_registration_id uuid, p_to uuid, p_expected_difference integer,
                                          p_actor uuid, p_actor_kind text, p_request_key uuid,
                                          p_offline_ack boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r         public.registrations%ROWTYPE;
  o         public.orders%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_to      public.competitions%ROWTYPE;
  v_key     text := p_request_key::text;
  v_from    uuid;
  v_orders  uuid[];
  v_list    integer;
  v_pct     integer;
  v_price   integer;
  v_diff    integer;
  v_amount  integer;
  v_part    integer;
  v_n       integer := 0;
  v_res     jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_first   uuid;
  v_buyer   record;
  v_expires timestamptz;
  v_order   uuid;
  l         record;
BEGIN
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('organizer', 'runner') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;

  -- Plain reads: what to lock.
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_from := r.category_id;

  -- 1. orders, by id: the entry's own, every surcharge of it, and any order holding a line of it.
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_orders FROM (
    SELECT r.order_id
    UNION SELECT x.id FROM public.orders x WHERE x.kind = 'surcharge' AND x.surcharge_registration_id = r.id
    UNION SELECT ol.order_id FROM public.order_lines ol
           WHERE ol.registration_id = r.id AND ol.kind IN ('entry', 'surcharge')
  ) AS s(x) WHERE x IS NOT NULL;
  PERFORM 1 FROM public.orders WHERE id = ANY (v_orders) ORDER BY id FOR UPDATE;

  -- A replay of the request key returns what the first call reserved (under the order lock, so a
  -- concurrent first call has committed or not started). A split refund's later parts carry
  -- '<key>:<n>'.
  IF v_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.refunds f WHERE f.request_key = v_key) THEN
    IF EXISTS (SELECT 1 FROM public.refunds f JOIN public.order_lines ol ON ol.id = f.order_line_id
                WHERE (f.request_key = v_key OR f.request_key LIKE v_key || ':%')
                  AND (ol.registration_id IS DISTINCT FROM r.id OR f.reason <> 'competition_change')) THEN
      RAISE EXCEPTION 'request_key_mismatch';
    END IF;
    SELECT jsonb_agg(jsonb_build_object(
             'refundId', f.id, 'messageId', f.message_id, 'grosze', f.amount, 'status', f.dpay_status,
             'requestedAt', f.requested_at, 'respondedAt', f.responded_at,
             'transactionId', pa.dpay_transaction_id)
             ORDER BY (f.request_key = v_key) DESC, f.request_key),
           sum(f.amount)::integer
      INTO v_refunds, v_amount
      FROM public.refunds f JOIN public.payment_attempts pa ON pa.id = f.payment_attempt_id
     WHERE f.request_key = v_key OR f.request_key LIKE v_key || ':%';
    RETURN jsonb_build_object('outcome', 'refund', 'refundId', v_refunds->0->'refundId', 'grosze', v_amount,
                              'refunds', v_refunds, 'replay', true);
  END IF;

  -- 2. the paid attempts of those orders, 3. the entry's money lines.
  PERFORM 1 FROM public.payment_attempts pa JOIN public.orders x ON x.id = pa.order_id
   WHERE x.id = ANY (v_orders) AND x.status = 'paid' AND pa.dpay_transaction_id = x.paid_transaction_id
   ORDER BY pa.id FOR UPDATE OF pa;
  PERFORM 1 FROM public.order_lines ol
   WHERE ol.order_id = ANY (v_orders) AND ol.registration_id = r.id AND ol.kind IN ('entry', 'surcharge')
   ORDER BY ol.id FOR UPDATE;
  -- 4. both competitions, by category_id.
  PERFORM 1 FROM public.competitions WHERE category_id IN (v_from, p_to) ORDER BY category_id FOR UPDATE;
  SELECT * INTO v_to FROM public.competitions WHERE category_id = p_to;
  IF NOT FOUND OR v_to.event_id <> r.event_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- 5. settings, 6. the registration.
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF r.category_id IS DISTINCT FROM v_from THEN
    -- Moved between the plain read and the lock: the locks above may be the wrong ones.
    RAISE EXCEPTION 'change_retry' USING ERRCODE = '40001';
  END IF;
  IF r.order_id IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = r.order_id;
  END IF;

  -- Checks, with every lock held.
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_live';
  END IF;
  IF r.team_id IS NOT NULL OR v_to.kind <> 'individual' THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  IF v_rs.state <> 'published' OR v_rs.closes_at IS NULL OR clock_timestamp() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'edits_closed';
  END IF;
  IF p_to = r.category_id THEN
    RAISE EXCEPTION 'same_competition';
  END IF;
  IF v_to.hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'unavailable';
  END IF;
  IF public.registration_refund_in_flight(r.id) THEN
    RAISE EXCEPTION 'refund_pending';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders x
              WHERE x.kind = 'surcharge' AND x.surcharge_registration_id = r.id AND x.status = 'pending') THEN
    RAISE EXCEPTION 'surcharge_open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transfers t
              WHERE t.registration_id = r.id AND t.status = 'pending' AND t.expires_at > now()) THEN
    RAISE EXCEPTION 'transfer_open';
  END IF;
  -- Raises ineligible / role_change; the result is re-derived by the move.
  PERFORM public.registration_competition_placement(p_to, r.birth_date, r.gender, r.email IS NULL,
                                                    v_rs.event_date, v_rs.age_reckoning);

  -- The target's list price: in the order's frozen tier (as a transfer prices it). An entry with no
  -- order (a free registration) can go only where the current tier asks nothing.
  IF r.order_id IS NULL THEN
    v_list := coalesce(public.registration_current_price(p_to), 0);
    IF v_list > 0 THEN
      RAISE EXCEPTION 'no_payer';
    END IF;
  ELSE
    v_list := public.registration_tier_price(p_to, o.tier_id);
    IF v_list IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
  END IF;
  -- The entry's voucher keeps its discount only where it is offered (no competitions listed: all).
  IF r.voucher_id IS NOT NULL AND v_list > 0 THEN
    SELECT v.percent INTO v_pct FROM public.vouchers v
     WHERE v.id = r.voucher_id
       AND (NOT EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id)
            OR EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id AND vc.category_id = p_to));
  END IF;
  v_price := public.registration_discounted_price(v_list, v_pct);
  v_diff := v_price - (r.price - r.refunded);
  IF p_expected_difference IS DISTINCT FROM v_diff THEN
    RAISE EXCEPTION 'price_changed:%', v_diff;
  END IF;

  -- D = 0: move now.
  IF v_diff = 0 THEN
    PERFORM public.registration_move_entry(r.id, p_to);
    UPDATE public.registrations SET list_price = v_list WHERE id = r.id;
    RETURN jsonb_build_object('outcome', 'moved', 'grosze', 0);
  END IF;

  -- D < 0: move now, the difference goes back.
  IF v_diff < 0 THEN
    v_amount := -v_diff;
    IF o.id IS NULL THEN
      RAISE EXCEPTION 'no_payer';
    END IF;
    IF o.paid_offline_at IS NOT NULL THEN
      -- Paid outside LESZY.RUN: the club gives the difference back by hand, so no refunds row; the
      -- entry books it as refunded so price − refunded stays the new price.
      IF NOT coalesce(p_offline_ack, false) THEN
        RAISE EXCEPTION 'offline_paid';
      END IF;
      PERFORM public.registration_move_entry(r.id, p_to);
      UPDATE public.registrations SET list_price = v_list, refunded = refunded + v_amount WHERE id = r.id;
      RETURN jsonb_build_object('outcome', 'moved_offline_refund', 'grosze', v_amount);
    END IF;
    IF v_rs.event_date IS NULL OR now() >= public.registration_refund_cutoff(v_rs.event_date) THEN
      RAISE EXCEPTION 'race_day';
    END IF;
    PERFORM public.registration_move_entry(r.id, p_to);
    UPDATE public.registrations SET list_price = v_list WHERE id = r.id;
    -- The newest paid order first, its surcharge line before an entry line; split over orders only
    -- when one does not hold enough. reserve_organizer_refund adds each part to the line's and the
    -- entry's refunded and refuses what its own caps refuse.
    FOR l IN
      SELECT ol.id, ol.amount - ol.refunded AS money_left, pa.id AS attempt_id, pa.grosze AS attempt_grosze
        FROM public.order_lines ol
        JOIN public.orders x ON x.id = ol.order_id
        JOIN public.payment_attempts pa ON pa.order_id = x.id AND pa.dpay_transaction_id = x.paid_transaction_id
       WHERE ol.order_id = ANY (v_orders) AND ol.registration_id = r.id AND ol.kind IN ('entry', 'surcharge')
         AND x.status = 'paid' AND x.paid_transaction_id IS NOT NULL AND ol.amount > ol.refunded
       ORDER BY x.paid_at DESC, (ol.kind = 'surcharge') DESC, ol.id
    LOOP
      EXIT WHEN v_amount = 0;
      v_part := least(v_amount, l.money_left, l.attempt_grosze - public.registration_attempt_refunds_held(l.attempt_id));
      CONTINUE WHEN v_part <= 0;
      v_res := public.reserve_organizer_refund(l.id, v_part, p_actor,
                 CASE WHEN v_key IS NULL THEN NULL WHEN v_n = 0 THEN v_key ELSE v_key || ':' || (v_n + 1) END, r.id);
      UPDATE public.refunds SET reason = 'competition_change' WHERE id = (v_res->>'refundId')::uuid;
      v_first := coalesce(v_first, (v_res->>'refundId')::uuid);
      v_refunds := v_refunds || jsonb_build_object(
        'refundId', v_res->'refundId', 'messageId', v_res->'messageId', 'grosze', v_part, 'status', 'pending',
        'requestedAt', NULL, 'respondedAt', NULL, 'transactionId', v_res->'transactionId');
      v_amount := v_amount - v_part;
      v_n := v_n + 1;
    END LOOP;
    IF v_amount > 0 THEN
      -- The entry's money is not on a paid line of it: nothing can be given back through dpay.
      RAISE EXCEPTION 'no_payer';
    END IF;
    RETURN jsonb_build_object('outcome', 'refund', 'refundId', v_first, 'grosze', -v_diff, 'refunds', v_refunds);
  END IF;

  -- D > 0: a surcharge order; the entry moves when it is paid (confirm_order, task 4).
  IF r.order_id IS NULL THEN
    RAISE EXCEPTION 'no_payer';
  END IF;
  -- Spec 14.10: online payment stops an hour before registration closes.
  IF now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;
  -- Nothing is claimed now, but a surcharge into a full competition could only be refunded.
  IF v_to.taken + 1 > v_to.capacity THEN
    RAISE EXCEPTION 'full';
  END IF;
  SELECT * INTO v_buyer FROM public.registration_surcharge_buyer(r.id);
  IF v_buyer.profile_id IS NULL AND v_buyer.email IS NULL THEN
    RAISE EXCEPTION 'no_payer';
  END IF;
  v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                    ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
  BEGIN
    INSERT INTO public.orders (
      event_id, buyer_profile_id, buyer_email, buyer_name, status, entry_total, extras_total, donation, total,
      tier_id, expires_at, kind, surcharge_registration_id, surcharge_from_category_id, surcharge_to_category_id,
      surcharge_list_price, surcharge_price)
    VALUES (
      r.event_id, v_buyer.profile_id, v_buyer.email, v_buyer.name, 'pending', v_diff, 0, 0, v_diff,
      o.tier_id, v_expires, 'surcharge', r.id, r.category_id, p_to, v_list, v_price)
    RETURNING id INTO v_order;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'surcharge_open';
  END;
  INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
  VALUES (v_order, 'surcharge', r.id, 1, v_diff);
  RETURN jsonb_build_object('outcome', 'surcharge', 'orderId', v_order, 'grosze', v_diff, 'expiresAt', v_expires);
END $$;
REVOKE EXECUTE ON FUNCTION public.change_competition(uuid, uuid, integer, uuid, text, uuid, boolean)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_competition(uuid, uuid, integer, uuid, text, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------- cancel_surcharge

-- A pending surcharge → cancelled. The entry, the original order and the slots are untouched (a
-- surcharge owns no registration and holds no slot). A payment still in flight lands on a cancelled
-- order and is refunded in full by confirm_order.
CREATE FUNCTION public.cancel_surcharge(p_order_id uuid, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF o.kind <> 'surcharge' THEN
    RAISE EXCEPTION 'not_surcharge';
  END IF;
  UPDATE public.orders
     SET status = 'cancelled', cancelled_reason = left(coalesce(p_reason, 'cancelled'), 500), cancelled_at = now()
   WHERE id = o.id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'status', o.status);
  END IF;
  RETURN jsonb_build_object('cancelled', true, 'status', 'cancelled');
END $$;
REVOKE EXECUTE ON FUNCTION public.cancel_surcharge(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_surcharge(uuid, text) TO service_role;
