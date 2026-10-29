-- Plan 3, user decision P3-R15 (2026-10-29): the capacity limit counts PAID entries only.
--
-- Until now create_order claimed a slot for every order and expire_orders /
-- cancel_order / release_orphan_orders gave it back. Now:
--   * competitions.taken counts confirmed entries only (paid, free, or a 0 zł order);
--   * create_order claims nothing for an order that must be paid. It refuses with
--     'full' when taken + n > capacity, under the competition lock (D3-1 unchanged);
--     a 0 zł order is confirmed at once and claims, as register_free does;
--   * confirm_order claims every slot of the order when the money arrives, pending or
--     expired alike, all or nothing (one subtransaction). When a competition is full,
--     hidden, the event unpublished or registration closed, the payment is refunded in
--     full (late_refund, reason full / unavailable / closed / duplicate) with an operator
--     alert, and a still-pending order is cancelled (reason the same) so nobody pays it again;
--   * registration_order_fits(order) tells pay-order, order-status and add_payment_attempt
--     whether the paid entries leave room; they refuse 'full' before a payment starts (for
--     the payer only; the claim at confirm is the authority);
--   * expire_orders, cancel_order and release_orphan_orders release nothing: an unpaid
--     order holds nothing. registration_release_slots stays for the cancellation or
--     refund of a confirmed entry (none exists yet).
--
-- Locks must not loosen with taken (drift check of plans 4-7): registration_check_locks and
-- the hide in publish_registration_changes key on registration_competition_in_use, which is
-- true while confirmed entries exist OR a live order (pending, expires_at in the future)
-- waits for payment in that competition. The limit itself may still go down to the
-- confirmed count (apply_registration_section's WHERE taken <= capacity, unchanged): people
-- who pay later into a full competition are refunded.
--
-- Every function is re-created from its latest definition; only the lines named above
-- change. A later change to any of them goes here.
--
-- Note (final review M10): start_list (20261030140000) recognises a deleted account by the
-- literal pair first_name = last_name = 'Usunięte konto' that delete-my-account writes; rename
-- the placeholder in both places together.

-- ---------------------------------------------------------------- in use

-- Plans 5 and 7 reuse this exact name and signature.
CREATE FUNCTION public.registration_competition_in_use(p_category_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = p_category_id AND c.taken > 0)
      OR EXISTS (SELECT 1 FROM public.registrations r JOIN public.orders o ON o.id = r.order_id
                  WHERE r.category_id = p_category_id AND r.status = 'pending_payment'
                    AND o.status = 'pending' AND o.expires_at > now())
$$;
REVOKE EXECUTE ON FUNCTION public.registration_competition_in_use(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_competition_in_use(uuid) TO service_role;

-- Whether the paid entries leave room for every slot a pending order would claim (a team is
-- one slot). For the payer only (pay-order, order-status, add_payment_attempt): it takes no
-- lock, so it can only say "no" early; confirm_order's claim decides.
CREATE FUNCTION public.registration_order_fits(p_order_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.registration_slot_units(p_order_id, ARRAY['pending_payment']) u
      JOIN public.competitions c ON c.category_id = u.category_id
     WHERE c.taken + u.n > c.capacity)
$$;
REVOKE EXECUTE ON FUNCTION public.registration_order_fits(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_order_fits(uuid) TO service_role;

-- ---------------------------------------------------------------- registration_check_locks (from 20261029220000)

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
  -- A custom consent somebody accepted stays, word for word (P2-R30).
  IF p_section = 'form' AND p_value ? 'consents' THEN
    IF EXISTS (
      SELECT 1 FROM public.event_consents ec
       WHERE ec.event_id = p_event_id AND ec.kind = 'custom'
         AND EXISTS (SELECT 1 FROM public.consent_acceptances ca WHERE ca.consent_id = ec.id)
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'consents') AS k
                          WHERE k->>'id' = ec.id::text AND k->>'text' = ec.text)) THEN
      RAISE EXCEPTION 'consent_locked';
    END IF;
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
    IF v_mode = 'fixed' THEN
      SELECT p.amount INTO v_old
        FROM public.competition_prices p JOIN public.price_tiers t ON t.id = p.tier_id
       WHERE p.category_id = v_comp.category_id AND t.ends_on IS NULL
       ORDER BY t.sort_order LIMIT 1;
      IF (v_item->>'price')::integer IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'price_locked';
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_check_locks(uuid, text, jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- publish_registration_changes (from 20261030130000)

CREATE OR REPLACE FUNCTION public.publish_registration_changes(p_event_id uuid, p_actor uuid,
                                                    p_expected_updated_at timestamptz DEFAULT NULL,
                                                    p_claim_notice boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_rs      public.registration_settings%ROWTYPE;
  v_pending public.registration_pending_changes%ROWTYPE;
  v_section text;
  v_value   jsonb;
  v_result  jsonb;
  v_ids     jsonb := '[]'::jsonb;
  v_item    jsonb;
  v_idx     bigint;
  v_id      uuid;
  v_allowed boolean;
  v_after   public.registration_settings%ROWTYPE;
BEGIN
  -- register_free's order: competition rows first, then the settings row.
  PERFORM 1 FROM public.competitions WHERE event_id = p_event_id ORDER BY category_id FOR UPDATE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_rs.state <> 'published' THEN
    RAISE EXCEPTION 'not_published';
  END IF;
  -- The edge function checked these; the RPC does not trust its caller.
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = v_rs.club_id AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role IN ('owner', 'admin'))
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_rs.club_id AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO v_pending FROM public.registration_pending_changes WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_changes';
  END IF;
  -- The edge function showed (and mailed) a diff of the row it read.
  IF p_expected_updated_at IS NOT NULL AND v_pending.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'changed';
  END IF;
  IF p_claim_notice THEN
    SELECT t.allowed INTO v_allowed FROM public.claim_throttle_slot('notice:' || p_event_id::text, 1, 3600) AS t;
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'notice_throttled';
    END IF;
  END IF;

  FOREACH v_section IN ARRAY ARRAY['basics', 'office', 'competitions', 'categories', 'timing', 'form', 'payments'] LOOP
    v_value := v_pending.payload->v_section;
    CONTINUE WHEN v_value IS NULL;
    PERFORM public.registration_check_locks(p_event_id, v_section, v_value);
    v_result := public.apply_registration_section(p_event_id, v_section, v_value, false);
    IF v_section = 'competitions' THEN
      v_ids := coalesce(v_result->'categoryIds', '[]'::jsonb);
      -- categoryIds follow the items' order; a new competition gets its id there.
      FOR v_item, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(v_value->'items') WITH ORDINALITY LOOP
        CONTINUE WHEN NOT v_item ? 'hidden';
        v_id := (v_ids->>(v_idx::integer - 1))::uuid;
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.competitions
                                   WHERE category_id = v_id AND (hidden_at IS NOT NULL) <> (v_item->>'hidden')::boolean);
        -- Only while nobody is registered and no live order waits for payment (P3-R15).
        -- Every competition row of the event is locked above, so a create_order that
        -- committed before the lock is visible here and none can start meanwhile.
        UPDATE public.competitions
           SET hidden_at = CASE WHEN (v_item->>'hidden')::boolean THEN now() ELSE NULL END
         WHERE category_id = v_id AND NOT public.registration_competition_in_use(v_id);
        IF NOT FOUND THEN
          RAISE EXCEPTION 'competition_locked';
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  SELECT * INTO v_after FROM public.registration_settings WHERE event_id = p_event_id;
  -- What the first publish's checklist required still holds (the edge function
  -- checks the whole checklist first; a direct call cannot skip these).
  IF v_after.opens_at IS NULL OR v_after.closes_at IS NULL OR v_after.event_date IS NULL THEN
    RAISE EXCEPTION 'invalid_state:window';
  END IF;
  IF v_after.closes_at > ((v_after.event_date + 1)::timestamp AT TIME ZONE 'Europe/Warsaw') THEN
    RAISE EXCEPTION 'invalid_state:closes_after_event';
  END IF;
  IF NOT ((v_after.regulamin_kind = 'pdf' AND v_after.regulamin_upload_id IS NOT NULL)
       OR (v_after.regulamin_kind = 'link' AND nullif(btrim(v_after.regulamin_url), '') IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid_state:regulamin';
  END IF;
  IF (v_after.regulamin_kind, v_after.regulamin_url, v_after.regulamin_upload_id)
     IS DISTINCT FROM (v_rs.regulamin_kind, v_rs.regulamin_url, v_rs.regulamin_upload_id) THEN
    UPDATE public.registration_settings SET regulamin_version = regulamin_version + 1 WHERE event_id = p_event_id;
  END IF;

  PERFORM public.registration_write_public_rows(p_event_id);
  DELETE FROM public.registration_pending_changes WHERE event_id = p_event_id;

  RETURN jsonb_build_object('categoryIds', v_ids, 'changedFields', to_jsonb(v_pending.changed_fields), 'publishedAt', now());
END $$;

-- ---------------------------------------------------------------- create_order (from 20261030110000)

CREATE OR REPLACE FUNCTION public.create_order(
  p_category_id uuid, p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_support_choice boolean, p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_comp      public.competitions%ROWTYPE;
  v_rs        public.registration_settings%ROWTYPE;
  v_n         integer;
  v_tier      uuid;
  v_tier_ends date;
  v_label     text;
  v_price     integer;
  v_entry     bigint;
  v_support   integer;
  v_fee       integer;
  v_total     bigint;
  v_free      boolean;
  v_buyer     text;
  v_profile   uuid;
  v_sent      uuid[];
  v_have      uuid[];
  v_order     uuid;
  v_expires   timestamptz;
  v_person    jsonb;
  v_email     text;
  v_reg       uuid;
  v_regs      uuid[] := '{}';
  v_ip        inet;
  v_ua        text := left(nullif(p_meta->>'userAgent', ''), 500);
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  v_n := jsonb_array_length(p_people);

  -- Ruling P3-R4: an order belongs to a signed-in account, and its buyer
  -- address is that account's address (reminders, refund and expiry mail go
  -- there). p_buyer_email is only checked against it, never stored as given.
  SELECT p.id, lower(btrim(p.email)) INTO v_profile, v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  IF v_profile IS NULL OR v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_buyer_email IS NOT NULL AND lower(btrim(p_buyer_email)) IS DISTINCT FROM v_buyer THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;

  -- D3-1: the competition, then the settings, as register_free.
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
  IF v_rs.pricing_mode = 'free' THEN
    RAISE EXCEPTION 'free_event';
  END IF;
  IF v_rs.opens_at IS NULL OR now() < v_rs.opens_at THEN
    RAISE EXCEPTION 'not_open';
  END IF;
  IF v_rs.closes_at IS NULL OR now() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  -- The current tier: the first whose last day (a Warsaw date) is today or later,
  -- an open-ended one last (the same choice as registration_raw).
  SELECT t.id, t.ends_on INTO v_tier, v_tier_ends
    FROM public.price_tiers t
   WHERE t.event_id = v_rs.event_id
     AND (t.ends_on IS NULL OR t.ends_on >= (now() AT TIME ZONE 'Europe/Warsaw')::date)
   ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id
   LIMIT 1;
  SELECT p.amount INTO v_price FROM public.competition_prices p
   WHERE p.tier_id = v_tier AND p.category_id = p_category_id;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'no_price';
  END IF;
  v_label := CASE WHEN v_tier_ends IS NULL THEN 'do zamknięcia zapisów'
                  ELSE 'do ' || to_char(v_tier_ends, 'DD.MM.YYYY') END;

  v_entry := v_price::bigint * v_n;
  IF v_entry > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_support := CASE WHEN v_entry > 0 THEN public.registration_support_fee(v_entry::integer, p_support_choice) ELSE 0 END;
  v_fee := public.registration_payment_fee((v_entry + v_support)::integer);
  v_total := v_entry + v_support + v_fee;
  IF v_total > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- D3-2: the person accepted exactly the consents the form showed, image included.
  SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
    FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
  SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
    FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id;
  IF v_sent IS DISTINCT FROM v_have THEN
    RAISE EXCEPTION 'consents_changed';
  END IF;

  -- At most two payable orders per account and event (an overdue one the job
  -- has not swept yet no longer counts). The lock makes the count and the
  -- insert one step, also across competitions of the event.
  PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
  IF (SELECT count(*) FROM public.orders o
       WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
         AND o.buyer_profile_id = v_profile) >= 2 THEN
    RAISE EXCEPTION 'too_many_pending';
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  -- P3-R15: the limit counts paid entries only. An order waiting for payment claims
  -- nothing; it is refused when the paid (confirmed) entries already fill the
  -- competition, and its slot is claimed by confirm_order when the money arrives.
  -- A total of 0 is confirmed here, so it claims now, as register_free does.
  IF v_free THEN
    IF public.claim_competition_slots(p_category_id, v_n) IS NULL THEN
      RAISE EXCEPTION 'full';
    END IF;
  ELSIF v_comp.taken + v_n > v_comp.capacity THEN
    RAISE EXCEPTION 'full';
  END IF;

  v_expires := least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at);
  INSERT INTO public.orders (
    event_id, buyer_profile_id, buyer_email, status, entry_total, extras_total, donation,
    support_choice, support_fee, payment_fee, total, tier_id, expires_at, paid_at)
  VALUES (
    v_rs.event_id, v_profile, v_buyer, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_entry, 0, 0,
    p_support_choice, v_support, v_fee, v_total, v_tier, v_expires, CASE WHEN v_free THEN now() END)
  RETURNING id INTO v_order;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  FOR v_person IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    v_email := lower(btrim(v_person->>'email'));
    BEGIN
      INSERT INTO public.registrations (
        event_id, category_id, order_id, status, profile_id, first_name, last_name, birth_date, gender, email,
        phone, city, club, ice_name, ice_phone, nationality, age_group_label, kids_group_id, consent_state,
        list_price, price)
      VALUES (
        v_rs.event_id, p_category_id, v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
        -- The account is this person's only when its address is theirs.
        (SELECT p.id FROM public.profiles p WHERE p.id = p_profile_id AND lower(p.email) = v_email),
        v_person->>'firstName', v_person->>'lastName', (v_person->>'birthDate')::date, v_person->>'gender',
        v_email, v_person->>'phone', v_person->>'city', v_person->>'club', v_person->>'iceName',
        v_person->>'icePhone', nullif(v_person->>'nationality', ''), v_person->>'ageGroupLabel', nullif(v_person->>'kidsGroupId', '')::uuid,
        'accepted', v_price, v_price)
      RETURNING id INTO v_reg;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate';
    END;

    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, v_profile, 'self',
           CASE WHEN ec.kind = 'regulamin' THEN v_rs.regulamin_version END, v_ip, v_ua
      FROM public.event_consents ec WHERE ec.event_id = v_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', v_profile, 'self', NULL, v_ip, v_ua;

    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_reg, 1, v_price, v_label, v_tier_ends);

    v_regs := v_regs || v_reg;
  END LOOP;

  IF v_free THEN
    PERFORM public.insert_registration_participant(r) FROM unnest(v_regs) AS r;
  END IF;

  RETURN jsonb_build_object(
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'paid' ELSE 'pending' END,
    'total', v_total,
    'amounts', jsonb_build_object(
      'entryTotal', v_entry, 'extrasTotal', 0, 'donation', 0,
      'supportFee', v_support, 'paymentFee', v_fee, 'total', v_total),
    'expiresAt', v_expires);
END $$;

-- ---------------------------------------------------------------- add_payment_attempt (from 20261030110000)

CREATE OR REPLACE FUNCTION public.add_payment_attempt(p_order_id uuid, p_txn text, p_grosze integer) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o      public.orders%ROWTYPE;
  v_id   uuid;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' OR o.expires_at <= now() THEN
    RAISE EXCEPTION 'not_payable';
  END IF;
  -- User decision: no new payment once registration has closed.
  IF NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                  WHERE rs.event_id = o.event_id AND rs.closes_at > now()) THEN
    RAISE EXCEPTION 'not_payable';
  END IF;
  IF p_grosze IS DISTINCT FROM o.total THEN
    RAISE EXCEPTION 'amount_mismatch';
  END IF;
  -- P3-R15, for the payer only: no payment starts into a competition the paid entries
  -- already fill. Not the authority (no lock is taken): confirm_order's claim is, and a
  -- payment that loses the race there is refunded in full.
  IF NOT public.registration_order_fits(o.id) THEN
    RAISE EXCEPTION 'full';
  END IF;
  INSERT INTO public.payment_attempts (order_id, dpay_transaction_id, grosze)
  VALUES (o.id, p_txn, p_grosze)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- confirm_order (from 20261030120000)

-- Internal: a payment that cannot be accepted leaves the order unpaid for good. A pending
-- order is cancelled (its registrations too) so it cannot be paid again; an expired one
-- stays expired. Nothing is released: an unpaid order holds no slot (P3-R15).
CREATE FUNCTION public.registration_drop_unpaid_order(p_order_id uuid, p_status text, p_reason text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF p_status <> 'pending' THEN
    RETURN;
  END IF;
  UPDATE public.orders SET status = 'cancelled', cancelled_reason = p_reason, cancelled_at = now()
   WHERE id = p_order_id AND status = 'pending';
  UPDATE public.registrations SET status = 'cancelled'
   WHERE order_id = p_order_id AND status = 'pending_payment';
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_drop_unpaid_order(uuid, text, text) FROM public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirm_order(p_order_id uuid, p_txn text, p_grosze integer, p_source text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o         public.orders%ROWTYPE;
  a         public.payment_attempts%ROWTYPE;
  v_found   boolean;
  v_closes  timestamptz;
  v_reason  text;
  v_refund  jsonb;
  u         record;
BEGIN
  -- (1) The order lock serialises confirm, expire and cancel of one order.
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  v_found := FOUND;

  -- (2) A correctly signed payment we cannot match is money received: alert.
  IF v_found THEN
    SELECT * INTO a FROM public.payment_attempts WHERE order_id = o.id AND dpay_transaction_id = p_txn;
    v_found := FOUND;
  END IF;
  IF NOT v_found THEN
    INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
    VALUES ('unknown_attempt', o.id, jsonb_build_object(
      'orderId', p_order_id, 'txn', p_txn, 'grosze', p_grosze, 'source', p_source),
      'unknown_attempt:' || coalesce(p_txn, ''))
    ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
    RETURN jsonb_build_object('outcome', 'unknown_attempt');
  END IF;

  -- (3) Ruling 6: a mismatch never confirms and never refunds.
  IF p_grosze IS DISTINCT FROM a.grosze OR p_grosze IS DISTINCT FROM o.total THEN
    INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
    VALUES ('amount_mismatch', o.id, jsonb_build_object(
      'attemptId', a.id, 'txn', p_txn, 'grosze', p_grosze, 'expected', o.total, 'source', p_source),
      'amount_mismatch:' || p_txn)
    ON CONFLICT ON CONSTRAINT operator_alerts_dedupe_key_key DO NOTHING;
    RETURN jsonb_build_object('outcome', 'amount_mismatch');
  END IF;

  -- (4) Ruling 8: only this statement leads to a confirmation or a refund.
  UPDATE public.payment_attempts SET status = 'paid', paid_at = now()
   WHERE id = a.id AND status = 'created';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome',
      CASE WHEN o.status = 'paid' AND o.paid_transaction_id = p_txn THEN 'already_confirmed' ELSE 'already_handled' END);
  END IF;

  -- (5) Branch on the order.
  IF o.status = 'paid' THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'double_payment', 'double_payment', p_source);
    RETURN jsonb_build_object('outcome', 'double_payment', 'refund', v_refund);
  END IF;
  IF o.status = 'cancelled' THEN
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'cancelled', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- D3-1: the order's competitions (category_id order), then the settings, before
  -- any registration is written. Both a pending and an expired order claim their
  -- slots here (P3-R15: the limit counts paid entries only), so both lock the
  -- competitions FOR UPDATE.
  PERFORM 1 FROM public.competitions c
   WHERE c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id)
   ORDER BY c.category_id
     FOR UPDATE;
  -- Ruling P3-R5: nothing is claimed in a competition hidden meanwhile, nor in an
  -- event no longer published; the payment is refunded. A pending order whose
  -- window is still open blocks hiding (registration_competition_in_use), so for
  -- it this only fires past expires_at, before the expiry job ran.
  IF EXISTS (SELECT 1 FROM public.competitions c
              WHERE c.hidden_at IS NOT NULL
                AND c.category_id IN (SELECT r.category_id FROM public.registrations r WHERE r.order_id = o.id))
     OR NOT EXISTS (SELECT 1 FROM public.registration_settings rs
                     WHERE rs.event_id = o.event_id AND rs.state = 'published') THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, 'unavailable');
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'unavailable', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- D3-7: at or after closes_at only an attempt created before it and confirmed
  -- within a 5-minute grace (the literal below) is accepted; everything else is
  -- refunded in full.
  SELECT rs.closes_at INTO v_closes FROM public.registration_settings rs WHERE rs.event_id = o.event_id
     FOR KEY SHARE;
  IF v_closes IS NULL
     OR (now() >= v_closes AND NOT (a.created_at < v_closes AND now() < v_closes + interval '5 minutes')) THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, 'closed');
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', 'closed', p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  -- The claim (P3-R15): every slot of the order, or none. The block is a
  -- subtransaction, so one full competition undoes the claims already made in the
  -- others and the whole order is refunded (never split, whatever it spans).
  BEGIN
    FOR u IN SELECT * FROM public.registration_slot_units(o.id,
               ARRAY[CASE WHEN o.status = 'pending' THEN 'pending_payment' ELSE 'expired' END]) LOOP
      IF public.claim_competition_slots(u.category_id, u.n) IS NULL THEN
        RAISE EXCEPTION 'full';
      END IF;
    END LOOP;
    UPDATE public.registrations SET status = 'confirmed'
     WHERE order_id = o.id AND status IN ('pending_payment', 'expired');
  EXCEPTION
    WHEN unique_violation THEN
      v_reason := 'duplicate';
    WHEN raise_exception THEN
      IF SQLERRM <> 'full' THEN
        RAISE;
      END IF;
      v_reason := 'full';
  END;
  IF v_reason IS NOT NULL THEN
    PERFORM public.registration_drop_unpaid_order(o.id, o.status, v_reason);
    v_refund := public.registration_refund_attempt(o.id, a.id, p_grosze, 'late_refund', v_reason, p_source);
    RETURN jsonb_build_object('outcome', 'late_refund', 'refund', v_refund);
  END IF;

  UPDATE public.orders SET status = 'paid', paid_at = now(), paid_transaction_id = p_txn
   WHERE id = o.id AND status IN ('pending', 'expired');
  PERFORM public.insert_registration_participant(r.id)
     FROM public.registrations r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.id;
  RETURN jsonb_build_object('outcome', CASE WHEN o.status = 'pending' THEN 'confirmed' ELSE 'late_confirmed' END);
END $$;

-- ---------------------------------------------------------------- cancel_order, expire_orders, release_orphan_orders (from 20261030125000)

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_reason text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.orders SET status = 'cancelled', cancelled_reason = left(p_reason, 500), cancelled_at = now()
   WHERE id = p_order_id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.registrations SET status = 'cancelled'
   WHERE order_id = p_order_id AND status = 'pending_payment';
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.expire_orders(p_now timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_n   integer := 0;
  r     record;
BEGIN
  BEGIN
    WITH due AS (
      SELECT o.id FROM public.orders o
       WHERE o.status = 'pending' AND o.expires_at <= p_now
       ORDER BY o.id
         FOR UPDATE SKIP LOCKED
    ), flipped AS (
      UPDATE public.orders o SET status = 'expired'
        FROM due WHERE o.id = due.id AND o.status = 'pending'
      RETURNING o.id
    )
    SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_ids FROM flipped;

    IF cardinality(v_ids) = 0 THEN
      RETURN 0;
    END IF;
    UPDATE public.registrations SET status = 'expired'
     WHERE order_id = ANY (v_ids) AND status = 'pending_payment';
    RETURN cardinality(v_ids);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- rolled back as a unit: go one order at a time
  END;

  FOR r IN
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.expires_at <= p_now
     ORDER BY (SELECT min(g.category_id::text) FROM public.registrations g WHERE g.order_id = o.id), o.id
       FOR UPDATE OF o SKIP LOCKED
  LOOP
    BEGIN
      UPDATE public.orders SET status = 'expired' WHERE id = r.id AND status = 'pending';
      IF FOUND THEN
        UPDATE public.registrations SET status = 'expired'
         WHERE order_id = r.id AND status = 'pending_payment';
        v_n := v_n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF NOT public.registration_transient_error(SQLSTATE) THEN
        INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
        VALUES ('expire_failed', r.id, jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE),
                'expire_failed:' || r.id || ':' || SQLSTATE)
        ON CONFLICT (dedupe_key) DO NOTHING;
      END IF;
    END;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.release_orphan_orders(p_now timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r     record;
  v_n   integer := 0;
BEGIN
  FOR r IN
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.created_at <= p_now - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id)
     ORDER BY (SELECT min(g.category_id::text) FROM public.registrations g WHERE g.order_id = o.id), o.id
       FOR UPDATE OF o SKIP LOCKED
  LOOP
    BEGIN
      UPDATE public.orders o
         SET status = 'cancelled', cancelled_reason = 'no_payment_attempt', cancelled_at = now()
       WHERE o.id = r.id AND o.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id);
      IF FOUND THEN
        UPDATE public.registrations SET status = 'cancelled'
         WHERE order_id = r.id AND status = 'pending_payment';
        v_n := v_n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF NOT public.registration_transient_error(SQLSTATE) THEN
        INSERT INTO public.operator_alerts (kind, order_id, payload, dedupe_key)
        VALUES ('orphan_release_failed', r.id, jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE),
                'orphan_release_failed:' || r.id || ':' || SQLSTATE)
        ON CONFLICT (dedupe_key) DO NOTHING;
      END IF;
    END;
  END LOOP;
  RETURN v_n;
END $$;
