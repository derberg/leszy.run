-- Runner self-service, task 12: the runner's own competition change and data edit, and their audit.
--
-- registration_changes is the append-only record of a runner's own change (organizer_actions is
-- the club's): the registration, the acting account, the kind, the NAMES of the fields that changed
-- (never a value), the competitions and the money difference. Service-role only; export-my-data
-- returns the person's rows, delete-my-account nulls actor_profile_id. A row goes with its
-- registration (ON DELETE CASCADE; registrations are anonymised, not deleted).
--
-- change_competition (recreated from 20261124120000_competition_change_settle.sql, changed only at
-- "Changed here (task 12)" and the three registration_log_runner_change calls): with
-- p_actor_kind = 'runner' it is refused not_allowed unless registration_settings.runner_competition_change,
-- an order paid outside LESZY.RUN is always offline_paid (the club gives that money back by hand, so
-- the club makes that change), a surcharge is billed to the acting runner (p_actor's profile),
-- and every outcome (moved, refund, surcharge created) writes one
-- registration_changes row with grosze = the signed difference. The organizer's calls are unchanged.
--
-- organizer_edit_registration (from 20261124110000_competition_change_rpc.sql) now calls the shared
-- internal registration_edit_person with p_runner = false and returns exactly what it returned
-- before. runner_edit_registration calls it with p_runner = true: firstName, lastName and email are
-- refused field_not_allowed, the club's runner_data_edit switch (not_allowed) and a team member who
-- is not the captain (team_member) are checked under the settings lock, and a change writes one
-- registration_changes row. Who may act is decided by the edge function; the RPC records p_actor.

-- ---------------------------------------------------------------- registration_changes

CREATE TABLE public.registration_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  uuid NOT NULL REFERENCES public.registrations(id) ON DELETE CASCADE,
  actor_profile_id uuid NULL,
  kind             text NOT NULL CHECK (kind IN ('competition', 'data')),
  fields           text[] NOT NULL DEFAULT '{}',
  from_category_id uuid NULL,
  to_category_id   uuid NULL,
  grosze           integer NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_changes_registration_idx ON public.registration_changes (registration_id, created_at);
CREATE INDEX registration_changes_actor_idx ON public.registration_changes (actor_profile_id) WHERE actor_profile_id IS NOT NULL;
ALTER TABLE public.registration_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_changes FROM anon, authenticated;

-- ---------------------------------------------------------------- registration_log_runner_change

-- One registration_changes row for a runner's competition change; nothing for the organizer's
-- (organizer-entry-action writes organizer_actions). Internal.
CREATE FUNCTION public.registration_log_runner_change(p_actor_kind text, p_registration_id uuid, p_actor uuid,
                                                       p_from uuid, p_to uuid, p_grosze integer) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF p_actor_kind = 'runner' THEN
    INSERT INTO public.registration_changes (registration_id, actor_profile_id, kind, from_category_id, to_category_id, grosze)
    VALUES (p_registration_id, p_actor, 'competition', p_from, p_to, p_grosze);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_log_runner_change(text, uuid, uuid, uuid, uuid, integer)
  FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_edit_person

-- The body of organizer_edit_registration (20261124110000), shared with the runner's edit. With
-- p_runner false it behaves exactly as before; it also returns `fields`, the names that changed.
-- Internal: runs inside the SECURITY DEFINER callers.
CREATE FUNCTION public.registration_edit_person(p_registration_id uuid, p_fields jsonb, p_runner boolean) RETURNS jsonb
  LANGUAGE plpgsql
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
  v_names   text[];
BEGIN
  IF jsonb_typeof(v_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_field';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
    -- The runner's own edit: never the names or the e-mail (a name change would sell the package
    -- past a disabled transfer; the e-mail is the one-start key and the account).
    IF p_runner AND v_key IN ('firstName', 'lastName', 'email') THEN
      RAISE EXCEPTION 'field_not_allowed';
    END IF;
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
  IF p_runner THEN
    -- The club's consent switch (the settings row is held FOR SHARE), and never a team member
    -- other than the captain. Ruling (task 12 review, 2026-11-25): a team CAPTAIN may edit their
    -- own personal data (it never touches the slot, the team or the fee); a non-captain member is
    -- refused team_member; a competition change is refused for every team entry
    -- (change_competition: team_competition).
    IF v_rs.runner_data_edit IS NOT TRUE THEN
      RAISE EXCEPTION 'not_allowed';
    END IF;
    IF r.team_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.teams t WHERE t.id = r.team_id AND t.captain_registration_id = r.id) THEN
      RAISE EXCEPTION 'team_member';
    END IF;
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
    -- The age rules live in registration_competition_placement (shared with a competition
    -- change). A kids group is re-derived only in a kids competition.
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
    RETURN jsonb_build_object('changed', false, 'ageGroupLabel', r.age_group_label, 'kidsGroupId', r.kids_group_id,
                              'fields', '[]'::jsonb);
  END IF;
  -- The names of the fields that change, never their values (registration_changes).
  SELECT coalesce(array_agg(n ORDER BY i), '{}') INTO v_names FROM (VALUES
      (1, 'firstName', v_first IS DISTINCT FROM r.first_name), (2, 'lastName', v_last IS DISTINCT FROM r.last_name),
      (3, 'birthDate', v_birth IS DISTINCT FROM r.birth_date), (4, 'gender', v_gender IS DISTINCT FROM r.gender),
      (5, 'phone', v_phone IS DISTINCT FROM r.phone), (6, 'city', v_city IS DISTINCT FROM r.city),
      (7, 'club', v_club IS DISTINCT FROM r.club), (8, 'nationality', v_nat IS DISTINCT FROM r.nationality),
      (9, 'iceName', v_icen IS DISTINCT FROM r.ice_name), (10, 'icePhone', v_icep IS DISTINCT FROM r.ice_phone)
    ) AS f(i, n, d) WHERE d;

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
  RETURN jsonb_build_object('changed', true, 'ageGroupLabel', v_label, 'kidsGroupId', v_kids,
                            'fields', to_jsonb(v_names));
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_edit_person(uuid, jsonb, boolean) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- organizer_edit_registration

CREATE OR REPLACE FUNCTION public.organizer_edit_registration(p_registration_id uuid, p_fields jsonb, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN public.registration_edit_person(p_registration_id, p_fields, false) - 'fields';
END $$;
REVOKE EXECUTE ON FUNCTION public.organizer_edit_registration(uuid, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organizer_edit_registration(uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------- runner_edit_registration

-- The runner's „Edytuj dane” → { changed, ageGroupLabel, kidsGroupId, fields }. Refusals: the
-- organizer edit's (invalid_field, not_found, not_live, edits_closed, edit_invalid, ineligible,
-- role_change, duplicate) plus field_not_allowed, not_allowed and team_member.
CREATE FUNCTION public.runner_edit_registration(p_registration_id uuid, p_fields jsonb, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_out jsonb;
BEGIN
  v_out := public.registration_edit_person(p_registration_id, p_fields, true);
  IF (v_out->>'changed')::boolean THEN
    INSERT INTO public.registration_changes (registration_id, actor_profile_id, kind, fields)
    VALUES (p_registration_id, p_actor, 'data', ARRAY(SELECT jsonb_array_elements_text(v_out->'fields')));
  END IF;
  RETURN v_out;
END $$;
REVOKE EXECUTE ON FUNCTION public.runner_edit_registration(uuid, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.runner_edit_registration(uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------- change_competition (from 20261124120000)

CREATE OR REPLACE FUNCTION public.change_competition(p_registration_id uuid, p_to uuid, p_expected_difference integer,
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
  v_buyer_name text;
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
                  AND (ol.registration_id IS DISTINCT FROM r.id OR f.reason <> 'competition_change'
                       OR f.change_to_category_id IS DISTINCT FROM p_to)) THEN
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
  IF r.team_id IS NOT NULL THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  -- Changed here (task 12): the runner's own change needs the club's consent switch. The
  -- settings row is held FOR SHARE, so a save of the payments section waits for this change.
  IF p_actor_kind = 'runner' AND v_rs.runner_competition_change IS NOT TRUE THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;
  IF v_rs.state <> 'published' OR v_rs.closes_at IS NULL OR clock_timestamp() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'edits_closed';
  END IF;
  IF p_to = r.category_id THEN
    RAISE EXCEPTION 'same_competition';
  END IF;
  IF v_to.hidden_at IS NOT NULL OR v_to.kind <> 'individual' THEN
    RAISE EXCEPTION 'unavailable';
  END IF;
  IF public.registration_refund_in_flight(r.id) THEN
    RAISE EXCEPTION 'refund_pending';
  END IF;
  -- Changed here: a pending surcharge whose window has passed counts as expired; it is expired now
  -- (what expire_orders does to it: a surcharge holds no registration, voucher use or stock), so it
  -- no longer blocks. Its orders row is locked in step 1.
  PERFORM public.registration_expire_due_surcharges(r.id);
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
    PERFORM public.registration_log_runner_change(p_actor_kind, r.id, p_actor, v_from, p_to, 0);
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
      -- Changed here (task 12): only the club, which holds the money, can promise it back.
      IF p_actor_kind = 'runner' OR NOT coalesce(p_offline_ack, false) THEN
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
      UPDATE public.refunds SET reason = 'competition_change', change_to_category_id = p_to
       WHERE id = (v_res->>'refundId')::uuid;
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
    PERFORM public.registration_log_runner_change(p_actor_kind, r.id, p_actor, v_from, p_to, v_diff);
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
  IF p_actor_kind = 'runner' THEN
    -- Changed here (task 12): the runner who asks for the dearer competition pays for it, signed
    -- in as p_actor (a child's entry: the guardian acting), never the original order's buyer, who
    -- chose neither this change nor, for an added adult, this person's competition. The name is
    -- the one the registration knows for the actor (the runner's own, by account or by the entry's
    -- address, as an added adult has no profile_id on it; or the guardian name), else the profile's
    -- display name.
    SELECT p.id AS profile_id, p.email AS email,
           CASE WHEN p.id = r.profile_id OR (r.email IS NOT NULL AND lower(p.email) = lower(r.email)) THEN nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), '')
                WHEN p.id = r.guardian_profile_id THEN r.guardian_name END AS name,
           p.display_name AS display_name
      INTO v_buyer
      FROM (SELECT x.id, x.email, x.display_name FROM public.profiles x
             WHERE x.id = p_actor AND x.deleted_at IS NULL AND x.email IS NOT NULL) p;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no_payer';
    END IF;
    v_buyer_name := coalesce(v_buyer.name, nullif(btrim(v_buyer.display_name), ''));
  ELSE
    SELECT * INTO v_buyer FROM public.registration_surcharge_buyer(r.id);
    v_buyer_name := v_buyer.name;
  END IF;
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
      r.event_id, v_buyer.profile_id, v_buyer.email, v_buyer_name, 'pending', v_diff, 0, 0, v_diff,
      o.tier_id, v_expires, 'surcharge', r.id, r.category_id, p_to, v_list, v_price)
    RETURNING id INTO v_order;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'surcharge_open';
  END;
  INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
  VALUES (v_order, 'surcharge', r.id, 1, v_diff);
  PERFORM public.registration_log_runner_change(p_actor_kind, r.id, p_actor, v_from, p_to, v_diff);
  RETURN jsonb_build_object('outcome', 'surcharge', 'orderId', v_order, 'grosze', v_diff, 'expiresAt', v_expires);
END $$;
REVOKE EXECUTE ON FUNCTION public.change_competition(uuid, uuid, integer, uuid, text, uuid, boolean)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_competition(uuid, uuid, integer, uuid, text, uuid, boolean) TO service_role;
