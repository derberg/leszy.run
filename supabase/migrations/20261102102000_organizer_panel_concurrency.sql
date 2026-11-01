-- Plan 6, task 3: a concurrency finding and the fixes from Task 2's review (task-2-review.md).
-- Every function below is recreated from 20261102100000_organizer_panel.sql or
-- 20261102101000_organizer_panel_edits.sql with only the marked changes; grants survive
-- CREATE OR REPLACE, and the one new helper gets its own.
--
--   reserve_organizer_refund     O-20b: one request_key sent at once for lines of two different
--                                orders passed both key lookups (each holds only its own order
--                                lock), and the second insert failed as a raw unique violation on
--                                refunds_request_key_key. It is 'request_key_mismatch' now.
--                                Review fix 5: a replay returns the refund's status, requestedAt and
--                                respondedAt; a new reservation answers status 'pending'.
--   settle_refund                Review fix 1: refuses kind = 'organizer' ('organizer_refund').
--   finish_organizer_refund      Review fix 2: a cancellation that fails never rolls back an accepted
--                                refund; one 'refund_cancel_failed' alert, the entry left to the operator.
--   organizer_cancel_order       Review fix 3: stamps cancelled_at / cancelled_by only on the rows it
--                                cancelled; cancel_registration reports only those.
--   cancel_registration          Review fix 6: the host_withdraw reason is a code ('refund',
--                                'organizer', anything else 'other'), never the caller's text.
--   extend_order_window          Review fix 4: also capped by the end of race day, so a NULL
--                                closes_at never leaves the 14 days alone.
--   rename_team                  Review fix 7: the whitespace class in \u escapes, as the
--                                teams_category_name_live_key index writes it. The same characters.
--   organizer_edit_registration  Review fix 8: nationality must be one of the form's codes
--                                (registration_country_ok; O-29h checks it against countries.js).

-- ---------------------------------------------------------------- registration_country_ok

-- The 249 codes of COUNTRY_CODES in _shared/registration/countries.js, the form's list.
CREATE FUNCTION public.registration_country_ok(p_code text) RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT p_code = ANY (ARRAY[
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB',
    'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY',
    'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX',
    'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK',
    'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS',
    'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR',
    'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA',
    'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
    'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE',
    'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
    'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG',
    'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF',
    'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY',
    'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  ]::text[])
$$;
REVOKE EXECUTE ON FUNCTION public.registration_country_ok(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_country_ok(text) TO service_role;

-- ---------------------------------------------------------------- settle_refund

CREATE OR REPLACE FUNCTION public.settle_refund(p_refund_id uuid, p_outcome text) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_attempt uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('pending', 'accepted', 'rejected', 'insufficient_balance', 'unknown') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  -- Review fix 1: an organizer refund settles only through finish_organizer_refund, where a 406 is
  -- final and a refusal gives the reservation back. Here a 406 is not final, and a rejection
  -- would leave order_lines.refunded holding money that never left.
  IF EXISTS (SELECT 1 FROM public.refunds WHERE id = p_refund_id AND kind = 'organizer') THEN
    RAISE EXCEPTION 'organizer_refund';
  END IF;
  UPDATE public.refunds
     SET dpay_status = p_outcome,
         next_retry_at = CASE WHEN p_outcome = 'insufficient_balance' AND kind = 'automatic'
                              THEN now() + interval '1 hour' END,
         responded_at = now()
   WHERE id = p_refund_id AND dpay_status NOT IN ('accepted', 'rejected')
  RETURNING payment_attempt_id INTO v_attempt;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.refunds WHERE id = p_refund_id) THEN
      RETURN 'already_settled';
    END IF;
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_outcome = 'accepted' THEN
    UPDATE public.payment_attempts a SET status = 'refunded'
     WHERE a.id = v_attempt
       AND (SELECT coalesce(sum(f.amount), 0) FROM public.refunds f
             WHERE f.payment_attempt_id = a.id AND f.dpay_status = 'accepted') >= a.grosze;
  END IF;
  RETURN 'settled';
END $$;

-- ---------------------------------------------------------------- reserve_organizer_refund

CREATE OR REPLACE FUNCTION public.reserve_organizer_refund(p_line_id uuid, p_grosze integer, p_actor uuid, p_request_key text)
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

  -- Both caps: the line's and record_refund's per attempt.
  SELECT * INTO l FROM public.order_lines WHERE id = p_line_id FOR UPDATE;
  v_left := least(l.amount - l.refunded, a.grosze - public.registration_attempt_refunds_held(a.id));
  IF p_grosze > v_left THEN
    RAISE EXCEPTION 'exceeds:%', greatest(v_left, 0);
  END IF;
  UPDATE public.order_lines SET refunded = refunded + p_grosze
   WHERE id = p_line_id AND refunded + p_grosze <= amount;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exceeds:%', greatest(l.amount - l.refunded, 0);
  END IF;
  IF l.kind = 'entry' THEN
    UPDATE public.registrations SET refunded = refunded + p_grosze WHERE id = l.registration_id;
  END IF;

  -- O-20b: the key lookup above is serialised by the ORDER lock, so the same key sent at once for a
  -- line of another order passes it too and meets the unique index here. That is the mismatch the
  -- lookup would have found; the whole reservation rolls back with the exception.
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

-- ---------------------------------------------------------------- finish_organizer_refund

CREATE OR REPLACE FUNCTION public.finish_organizer_refund(p_refund_id uuid, p_outcome text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  f        public.refunds%ROWTYPE;
  a        public.payment_attempts%ROWTYPE;
  l        public.order_lines%ROWTYPE;
  v_status text;
  v_out    jsonb;
  v_cancel jsonb := '[]'::jsonb;
  v_host   boolean := false;
  v_state  text;
  v_err    text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('pending', 'accepted', 'rejected', 'insufficient_balance', 'unknown') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  SELECT * INTO f FROM public.refunds WHERE id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF f.kind <> 'organizer' OR f.order_line_id IS NULL THEN
    RAISE EXCEPTION 'not_organizer';
  END IF;

  PERFORM 1 FROM public.orders WHERE id = f.order_id FOR UPDATE;
  SELECT * INTO a FROM public.payment_attempts WHERE id = f.payment_attempt_id FOR UPDATE;
  SELECT * INTO l FROM public.order_lines WHERE id = f.order_line_id FOR UPDATE;

  UPDATE public.refunds
     SET dpay_status = p_outcome, responded_at = now(), next_retry_at = NULL
   WHERE id = p_refund_id AND dpay_status IN ('pending', 'unknown')
  RETURNING * INTO f;
  IF NOT FOUND THEN
    SELECT dpay_status INTO v_status FROM public.refunds WHERE id = p_refund_id;
    RETURN jsonb_build_object('status', v_status, 'settled', 'already_settled',
                              'cancelled', '[]'::jsonb, 'hostWithdraw', false);
  END IF;

  IF p_outcome IN ('rejected', 'insufficient_balance') THEN
    UPDATE public.order_lines SET refunded = refunded - f.amount WHERE id = l.id;
    IF l.kind = 'entry' THEN
      UPDATE public.registrations SET refunded = refunded - f.amount WHERE id = l.registration_id;
    END IF;
  ELSIF p_outcome = 'accepted' THEN
    UPDATE public.payment_attempts SET status = 'refunded'
     WHERE id = a.id
       AND (SELECT coalesce(sum(x.amount), 0) FROM public.refunds x
             WHERE x.payment_attempt_id = a.id AND x.dpay_status = 'accepted') >= a.grosze;
    -- Money that left for the whole line ends the entry; a reservation alone never does.
    IF l.kind = 'entry'
       AND (SELECT coalesce(sum(x.amount), 0) FROM public.refunds x
             WHERE x.order_line_id = l.id AND x.dpay_status = 'accepted') >= l.amount
       AND EXISTS (SELECT 1 FROM public.registrations x WHERE x.id = l.registration_id AND x.status = 'confirmed') THEN
      -- Review fix 2: dpay has moved the money, so the acceptance is stored whatever happens to the
      -- cancellation. A cancel that fails rolls back alone (a subtransaction), is alerted and leaves
      -- the entry for the operator.
      BEGIN
        v_out := public.cancel_registration(l.registration_id, 'refund', f.requested_by);
        v_cancel := v_out->'cancelled';
        v_host := (v_out->>'hostWithdraw')::boolean;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
        VALUES ('refund_cancel_failed', f.order_id, jsonb_build_object(
          'refundId', f.id, 'registrationId', l.registration_id, 'error', left(v_err, 200), 'sqlstate', v_state),
          'refund_cancel_failed:' || f.id)
        ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', p_outcome, 'settled', 'settled', 'cancelled', v_cancel, 'hostWithdraw', v_host);
END $$;

-- ---------------------------------------------------------------- organizer_cancel_order

CREATE OR REPLACE FUNCTION public.organizer_cancel_order(p_order_id uuid, p_actor uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o     public.orders%ROWTYPE;
  v_ids uuid[];
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF o.status = 'cancelled' THEN
    RETURN 'cancelled_already';
  END IF;
  IF o.status <> 'pending' THEN
    RETURN o.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id AND a.status <> 'created') THEN
    RETURN 'payment_received';
  END IF;
  -- Review fix 3: the rows cancel_order is about to flip, read under the order lock (a squad edit
  -- takes it too). A pending team's earlier swap-out is cancelled already and is not ours to stamp.
  SELECT coalesce(array_agg(r.id), '{}') INTO v_ids FROM public.registrations r
   WHERE r.order_id = o.id AND r.status = 'pending_payment';
  IF NOT public.cancel_order(o.id, 'organizer_cancelled') THEN
    RETURN 'not_found';
  END IF;
  UPDATE public.registrations SET cancelled_at = now(), cancelled_by = p_actor
   WHERE id = ANY (v_ids) AND status = 'cancelled';
  RETURN 'cancelled';
END $$;

-- ---------------------------------------------------------------- cancel_registration

CREATE OR REPLACE FUNCTION public.cancel_registration(p_registration_id uuid, p_reason text, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  c_live    constant text[] := ARRAY['pending_payment', 'confirmed'];
  r         public.registrations%ROWTYPE;
  v_comp    public.competitions%ROWTYPE;
  v_rs      public.registration_settings%ROWTYPE;
  v_team    public.teams%ROWTYPE;
  v_text    text;
  v_targets uuid[];
  v_done    uuid[];
  v_whole   boolean;
  v_live    integer;
  v_bibs    jsonb;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Unpaid: the whole order goes (ruling 6). It held no slot (P3-R15).
  IF r.status = 'pending_payment' THEN
    IF r.order_id IS NULL THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    v_text := public.organizer_cancel_order(r.order_id, p_actor);
    IF v_text <> 'cancelled' THEN
      RAISE EXCEPTION '%', CASE WHEN v_text = 'cancelled_already' THEN 'already_cancelled' ELSE v_text END;
    END IF;
    SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}') INTO v_done FROM public.registrations x
     WHERE x.order_id = r.order_id AND x.status = 'cancelled' AND x.cancelled_at = now()
       AND x.cancelled_by IS NOT DISTINCT FROM p_actor;
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION '%', CASE WHEN r.status = 'cancelled' THEN 'already_cancelled' ELSE 'not_live' END;
  END IF;

  -- Confirmed: the locks in the Global Constraints order. Plan 2's free path has no order.
  IF r.order_id IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = r.order_id FOR UPDATE;
  END IF;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = r.category_id FOR UPDATE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  IF r.team_id IS NOT NULL THEN
    SELECT * INTO v_team FROM public.teams WHERE id = r.team_id FOR UPDATE;
    PERFORM 1 FROM public.registrations WHERE team_id = r.team_id AND status = ANY (c_live) ORDER BY id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.registrations WHERE id = r.id FOR UPDATE;
  END IF;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  IF r.team_id IS NULL THEN
    v_targets := ARRAY[r.id];
    v_whole := true;
  ELSIF r.id = v_team.captain_registration_id THEN
    -- The captain takes the team (ruling 6, §12.7).
    SELECT array_agg(x.id ORDER BY x.id) INTO v_targets FROM public.registrations x
     WHERE x.team_id = r.team_id AND x.status = 'confirmed';
    v_whole := true;
  ELSE
    -- One member, no refund (members carry 0, §14.14), never below the squad minimum.
    SELECT count(*) INTO v_live FROM public.registrations x WHERE x.team_id = r.team_id AND x.status = ANY (c_live);
    IF v_live - 1 < v_comp.team_min THEN
      RAISE EXCEPTION 'below_team_min';
    END IF;
    v_targets := ARRAY[r.id];
    v_whole := false;
  END IF;

  -- The slot first (D6-26), then the flip; a flip that finds nothing rolls the release back.
  IF v_whole THEN
    UPDATE public.competitions SET taken = taken - 1 WHERE category_id = r.category_id;
  END IF;
  WITH flipped AS (
    UPDATE public.registrations
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor
     WHERE id = ANY (v_targets) AND status = 'confirmed'
    RETURNING id
  )
  SELECT array_agg(id ORDER BY id) INTO v_done FROM flipped;
  IF v_done IS NULL THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_whole AND r.team_id IS NOT NULL THEN
    UPDATE public.teams SET released_at = coalesce(released_at, now()) WHERE id = r.team_id;
  END IF;

  -- §14.3: before close the participant leaves through removed_at; from close on the timing
  -- host owns the row, so the operator crew is told instead.
  IF v_rs.closes_at IS NOT NULL AND clock_timestamp() < v_rs.closes_at THEN
    UPDATE public.participants p SET removed_at = now(), updated_at = now()
      FROM public.registrations x
     WHERE x.id = ANY (v_done) AND p.id = x.participant_id AND p.removed_at IS NULL;
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;

  SELECT jsonb_agg(p.bib_number ORDER BY x.id) INTO v_bibs
    FROM public.registrations x JOIN public.participants p ON p.id = x.participant_id
   WHERE x.id = ANY (v_done);
  IF v_bibs IS NULL THEN
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;
  INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
  VALUES ('host_withdraw', r.order_id, jsonb_build_object(
    'registrationIds', to_jsonb(v_done), 'eventId', r.event_id, 'bibs', v_bibs, -- Review fix 6: a code, never the caller's text (this payload skips redactDpay, D6-29).
    'reason', CASE WHEN p_reason IN ('refund', 'organizer') THEN p_reason ELSE 'other' END),
    'host_withdraw:' || r.id)
  ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
  RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', true);
END $$;

-- ---------------------------------------------------------------- extend_order_window

CREATE OR REPLACE FUNCTION public.extend_order_window(p_order_id uuid, p_until timestamptz, p_actor uuid) RETURNS timestamptz
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o        public.orders%ROWTYPE;
  v_closes timestamptz;
  v_until  timestamptz;
  v_date   date;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT rs.closes_at, rs.event_date INTO v_closes, v_date
    FROM public.registration_settings rs WHERE rs.event_id = o.event_id FOR SHARE;
  -- Review fix 4: least() skips a NULL, so a missing closes_at must not leave the 14 days alone.
  -- The end of race day (Warsaw) is as late as closes_at may ever be (registration_check_locks).
  v_closes := least(v_closes, ((v_date + 1)::timestamp AT TIME ZONE 'Europe/Warsaw'));

  UPDATE public.orders
     SET expires_at = p_until, extended_at = now(), extended_by = p_actor, reminder_sent_at = NULL
   WHERE id = p_order_id AND status = 'pending' AND expires_at > now()
     AND p_until > expires_at
     AND v_closes IS NOT NULL
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

-- ---------------------------------------------------------------- rename_team

CREATE OR REPLACE FUNCTION public.rename_team(p_team_id uuid, p_name text, p_actor uuid) RETURNS text
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
                  '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'),
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
