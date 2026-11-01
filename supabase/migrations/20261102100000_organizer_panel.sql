-- Plan 6, task 2a: the organizer's refunds and cancellations.
--
-- A refund the organizer asks for is RESERVED before dpay is called and SETTLED by dpay's answer:
--   reserve_organizer_refund(line, grosze, actor, request_key)
--       → { refundId, messageId, transactionId, replay }
--       Under the order lock, then the paid attempt's (record_refund's order, D3-1, D6-19), it
--       moves order_lines.refunded (and registrations.refunded for an entry line) and inserts the
--       refunds row (kind 'organizer', dpay_status 'pending'). One request_key is one refund: a
--       replay returns the first row, a different line or amount is 'request_key_mismatch'.
--       Refusals: invalid_amount, not_found, not_paid, race_day, exceeds:<grosze still refundable>.
--   finish_organizer_refund(refund, outcome) → { status, settled, cancelled, hostWithdraw }
--       The organizer refund's settle step (D6-20): settle_refund's guarded update, from pending
--       or unknown only (an organizer 406 is final, ruling 3: the organizer retries by hand), with
--       responded_at stamped and no next_retry_at. accepted cancels the entry once the accepted
--       refunds cover its line (a team line: the whole team, §12.7); rejected and
--       insufficient_balance give the reservation back; pending and unknown keep it (D6-21). The
--       operator alert is executeRefund's refund_<outcome>, not one written here.
--   resolve_organizer_refund(refund, outcome, note) the operator's answer for an unknown or
--       pending refund, after checking the dpay panel: the same effects, plus resolved_by.
--
-- Cancelling:
--   organizer_cancel_order(order, actor) → text   D6-24: buyer_cancel_order's checks without the
--       buyer, then cancel_order(…, 'organizer_cancelled'). It never refunds and releases nothing
--       (an unpaid order holds no slot, P3-R15). A payment landing afterwards is confirm_order's
--       late_refund reason 'cancelled'.
--   cancel_registration(registration, reason, actor) → { cancelled, hostWithdraw }
--       pending_payment: the whole order through organizer_cancel_order (ruling 6). confirmed:
--       the slot is released first (one unit; a team once, only when the captain and so the
--       whole team goes, D6-26), then the guarded flip; no row flipped → 'already_cancelled' and
--       the release rolls back with it. A team member alone may go (§14.14) but never below
--       team_min ('below_team_min'); the captain takes the team, whose name the
--       teams_follow_captain trigger releases. Before closes_at the participant gets removed_at;
--       at or after it nothing touches participants (§14.3): hostWithdraw is true and one
--       host_withdraw operator alert names the registrations, the event and the bibs, never a
--       name (D6-29).
--
-- Lock order (Plan 6 Global Constraints): orders → payment_attempts → order_lines → competitions
-- (category_id order) → registration_settings → teams → registrations → participants. Every path
-- below takes a prefix of it.
--
-- Recreated: settle_refund and stalled_refunds from 20261030125000, record_refund from
-- 20261030110000. settle_refund schedules a retry for an automatic refund only (D6-20) and marks
-- the attempt refunded only once its accepted refunds cover it (Plan 3 ledger M6); stalled_refunds
-- drops its kind = 'automatic' filter (D6-22); record_refund's per-attempt cap stops counting an
-- organizer refund dpay refused with 406, whose reservation was given back.
--
-- Ruling 1 (refund cutoff) is still open with the user (D6-31). registration_refund_cutoff is its
-- only home: refunds stop at 00:00 Warsaw on event_date. "Through race day" is the one-line
-- change of p_event_date to p_event_date + 1 there.

-- ---------------------------------------------------------------- columns

ALTER TABLE public.refunds
  ADD COLUMN request_key        text UNIQUE,
  ADD COLUMN runner_notified_at timestamptz,
  ADD COLUMN resolved_by        text CHECK (char_length(resolved_by) <= 500);

ALTER TABLE public.orders
  ADD COLUMN extended_at timestamptz,
  ADD COLUMN extended_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX orders_extended_by_idx ON public.orders (extended_by);

ALTER TABLE public.registrations
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX registrations_cancelled_by_idx ON public.registrations (cancelled_by);

-- ---------------------------------------------------------------- the refund cutoff (ruling 1, D6-31)

-- The instant organizer refunds stop: 00:00 Warsaw on the race day (refused from then on,
-- "Zwroty są zamknięte od dnia zawodów."). The same instant as warsawDayStart(event_date).
CREATE FUNCTION public.registration_refund_cutoff(p_event_date date) RETURNS timestamptz
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT (p_event_date::timestamp AT TIME ZONE 'Europe/Warsaw')
$$;
REVOKE EXECUTE ON FUNCTION public.registration_refund_cutoff(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_refund_cutoff(date) TO service_role;

-- What a payment attempt has given back or still may: every refund but a rejected one and an
-- organizer 406 (its reservation was released). An automatic 406 is retried, so it still counts.
CREATE FUNCTION public.registration_attempt_refunds_held(p_attempt_id uuid) RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT coalesce(sum(f.amount), 0)::integer FROM public.refunds f
   WHERE f.payment_attempt_id = p_attempt_id
     AND f.dpay_status <> 'rejected'
     AND NOT (f.kind = 'organizer' AND f.dpay_status = 'insufficient_balance')
$$;
REVOKE EXECUTE ON FUNCTION public.registration_attempt_refunds_held(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- record_refund (from 20261030110000)

-- Unchanged apart from the cap, which reads registration_attempt_refunds_held.
CREATE OR REPLACE FUNCTION public.record_refund(p_attempt_id uuid, p_grosze integer, p_kind text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  a     public.payment_attempts%ROWTYPE;
  v_id  uuid := gen_random_uuid();
  v_msg text := left(replace(v_id::text, '-', ''), 24);
BEGIN
  IF p_grosze IS NULL OR p_grosze <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  -- D3-1: the order before the attempt, as confirm_order takes them.
  PERFORM 1 FROM public.orders o
   WHERE o.id = (SELECT pa.order_id FROM public.payment_attempts pa WHERE pa.id = p_attempt_id)
     FOR UPDATE;
  SELECT * INTO a FROM public.payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_grosze + public.registration_attempt_refunds_held(a.id) > a.grosze THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  INSERT INTO public.refunds (id, order_id, payment_attempt_id, amount, kind, reason, message_id)
  VALUES (v_id, a.order_id, a.id, p_grosze, p_kind, p_reason, v_msg);
  RETURN jsonb_build_object('refundId', v_id, 'messageId', v_msg);
END $$;

-- ---------------------------------------------------------------- settle_refund (from 20261030125000)

-- D6-20: next_retry_at only for an automatic refund (the retry job must never pick an organizer
-- refund, ruling 3), and the attempt is refunded only once its accepted refunds cover it.
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

-- ---------------------------------------------------------------- stalled_refunds (from 20261030125000)

-- D6-22: organizer refunds too (the kind filter is gone), with the same alerts and dedupe keys.
CREATE OR REPLACE FUNCTION public.stalled_refunds(p_limit integer DEFAULT 100)
  RETURNS TABLE (refund_id uuid, order_id uuid, attempt_id uuid, amount integer, reason text,
                 alert_kind text, dedupe_key text, requested_at timestamptz, created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT s.* FROM (
    SELECT f.id, f.order_id, f.payment_attempt_id, f.amount, f.reason,
           CASE WHEN f.requested_at IS NULL THEN 'refund_never_sent' ELSE 'refund_stalled' END AS alert_kind,
           CASE WHEN f.requested_at IS NULL THEN 'refund_never_sent:' || f.id
                ELSE 'refund_stalled:' || f.id || ':' || floor(extract(epoch FROM f.requested_at))::bigint END AS dedupe_key,
           f.requested_at, f.created_at
      FROM public.refunds f
     WHERE f.dpay_status NOT IN ('accepted', 'rejected')
       AND f.next_retry_at IS NULL
       AND ((f.requested_at IS NULL AND f.created_at < now() - interval '10 minutes')
         OR (f.requested_at < now() - interval '15 minutes'
             AND (f.responded_at IS NULL OR f.responded_at < f.requested_at)))
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM public.operator_alerts al WHERE al.dedupe_key = s.dedupe_key)
  ORDER BY s.created_at
  LIMIT greatest(p_limit, 0)
$$;

-- ---------------------------------------------------------------- organizer_cancel_order (D6-24)

-- → 'cancelled', or the refusal: 'not_found', 'paid' / 'expired' / 'cancelled_already',
--   'payment_received' (an attempt is paid or refunded: money moved).
CREATE FUNCTION public.organizer_cancel_order(p_order_id uuid, p_actor uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o public.orders%ROWTYPE;
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
  IF NOT public.cancel_order(o.id, 'organizer_cancelled') THEN
    RETURN 'not_found';
  END IF;
  UPDATE public.registrations SET cancelled_at = now(), cancelled_by = p_actor
   WHERE order_id = o.id AND status = 'cancelled' AND cancelled_at IS NULL;
  RETURN 'cancelled';
END $$;
REVOKE EXECUTE ON FUNCTION public.organizer_cancel_order(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organizer_cancel_order(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------- cancel_registration

CREATE FUNCTION public.cancel_registration(p_registration_id uuid, p_reason text, p_actor uuid) RETURNS jsonb
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
     WHERE x.order_id = r.order_id AND x.status = 'cancelled' AND x.cancelled_at = now();
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
    'registrationIds', to_jsonb(v_done), 'eventId', r.event_id, 'bibs', v_bibs, 'reason', left(p_reason, 100)),
    'host_withdraw:' || r.id)
  ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
  RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', true);
END $$;
REVOKE EXECUTE ON FUNCTION public.cancel_registration(uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_registration(uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------- reserve_organizer_refund

CREATE FUNCTION public.reserve_organizer_refund(p_line_id uuid, p_grosze integer, p_actor uuid, p_request_key text)
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
      RETURN jsonb_build_object('refundId', f.id, 'messageId', f.message_id, 'replay', true,
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

  INSERT INTO public.refunds (id, order_id, payment_attempt_id, order_line_id, amount, kind, reason,
                              requested_by, message_id, request_key)
  VALUES (v_id, o.id, a.id, l.id, p_grosze, 'organizer', 'organizer', p_actor, v_msg, p_request_key);
  RETURN jsonb_build_object('refundId', v_id, 'messageId', v_msg, 'transactionId', a.dpay_transaction_id,
                            'replay', false);
END $$;
REVOKE EXECUTE ON FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_organizer_refund(uuid, integer, uuid, text) TO service_role;

-- ---------------------------------------------------------------- finish_organizer_refund

CREATE FUNCTION public.finish_organizer_refund(p_refund_id uuid, p_outcome text) RETURNS jsonb
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
      v_out := public.cancel_registration(l.registration_id, 'refund', f.requested_by);
      v_cancel := v_out->'cancelled';
      v_host := (v_out->>'hostWithdraw')::boolean;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', p_outcome, 'settled', 'settled', 'cancelled', v_cancel, 'hostWithdraw', v_host);
END $$;
REVOKE EXECUTE ON FUNCTION public.finish_organizer_refund(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_organizer_refund(uuid, text) TO service_role;

-- ---------------------------------------------------------------- resolve_organizer_refund

-- The operator's call on a refund dpay never answered for certain (backend script
-- resolve-registration-refund.js, after the dpay panel). p_note is who decided and on what.
CREATE FUNCTION public.resolve_organizer_refund(p_refund_id uuid, p_outcome text, p_note text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  f     public.refunds%ROWTYPE;
  v_out jsonb;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'invalid_outcome';
  END IF;
  IF nullif(btrim(p_note), '') IS NULL THEN
    RAISE EXCEPTION 'note_required';
  END IF;
  SELECT * INTO f FROM public.refunds WHERE id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF f.kind <> 'organizer' THEN
    RAISE EXCEPTION 'not_organizer';
  END IF;
  v_out := public.finish_organizer_refund(p_refund_id, p_outcome);
  IF v_out->>'settled' <> 'settled' THEN
    RAISE EXCEPTION 'not_unresolved';
  END IF;
  UPDATE public.refunds SET resolved_by = left(btrim(p_note), 500) WHERE id = p_refund_id;
  RETURN v_out;
END $$;
REVOKE EXECUTE ON FUNCTION public.resolve_organizer_refund(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_organizer_refund(uuid, text, text) TO service_role;
