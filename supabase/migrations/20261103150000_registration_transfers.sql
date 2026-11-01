-- Plan 7, task 6: handing a package to another person (§2 transfer, §4.5, §4.8, §14.3, §14.14,
-- rulings 1–5, D7-14, D7-24).
--
--   create_transfer     the holder invites one address. The token's SHA-256 is all the database
--                       keeps (Plan 4's pattern: the token travels only in the URL fragment).
--   cancel_transfer     the holder takes the invite back.
--   accept_transfer     the recipient takes the package: one transaction, whose gate is
--                       UPDATE transfers … WHERE status = 'pending' AND expires_at > now() RETURNING.
--   organizer_transfer  B3 types the recipient in, until 00:00 Warsaw on the race day.
--   apply_transfer      internal: what both accepts do.
--   cancel_registration (from 20261103130000) also cancels a pending invite of every entry it
--                       cancels, so the link of a cancelled or refunded entry dies with it.
--
-- What a transfer does (apply_transfer):
--   * The old registration becomes transferred_out and a new confirmed one takes its place with the
--     same order_id, list_price, price, refunded, voucher_id and partner_id. Nothing is payable: no
--     fee exists (ruling 1, T4-F), and the money stays between the two people.
--   * The entry and extra lines of the old registration move to the new one; the donation line
--     (no registration) stays where it is.
--   * The slot moves, never claimed or freed (P3-R15): `taken` is untouched within a competition,
--     and across competitions the old one gives one and the new one takes one with no capacity
--     check (§4.8). An unpaid order in the target holds nothing and meets `full` when it pays.
--   * A voucher stays used: the new registration holds it (the voucher invariant counts live rows).
--   * A team captain's transfer repoints teams.captain_registration_id to the new row BEFORE the old
--     one leaves live, so teams_follow_captain never releases the team; the team keeps its
--     competition, and the leg moves after the old row has left live (the leg key is unique among
--     live rows).
--   * The recipient must be 18 or over on the race day (Warsaw), the same rule that gives a person
--     the role minor in a group (ruling 3). Their own live entry: confirmed → duplicate; unpaid and
--     alone in its order → that order is cancelled in this transaction (its uses and stock go back,
--     it held no slot); unpaid in a group or team order → pending_elsewhere.
--   * "Same price" is the target's list price in the old order's frozen tier (ruling 2); a free
--     entry (no order, or an order with no tier) transfers between 0 zł competitions only.
--   * Before closes_at the old participant gets removed_at. From closes_at on the timing host owns
--     the row: it is left alone, and one host_withdraw alert names the registration, the event and
--     the bib, never the name (D7-24, D6-29). Then the new participant is inserted (no bib).
--
-- Lock order (Global Constraints): orders (the old one and the recipient's unpaid one, by id) →
-- the old entry's order_lines → competitions (old, target and every competition of the
-- recipient's unpaid order, by category_id) → registration_settings → teams → the recipient's
-- vouchers and variants (by id) → registrations (by id) → participants → transfers. The inner
-- cancel_order takes nothing more. create_transfer and cancel_transfer lock the registration and
-- then the transfer, a suffix of the same order, so an accept, a cancel and a second recipient
-- serialize on the registration row.
--
-- Error codes (RAISE messages): not_found, not_owner, not_transferable, transfer_off, same_person,
-- pending_exists, invalid_email, invalid_token, gone, recipient_minor, price_differs, duplicate,
-- pending_elsewhere, team_competition, unavailable, consents_required, consents_changed,
-- profile_mismatch, invalid_person, race_day, refund_pending, transferred (cancel_registration of a transferred_out row); transfer_retry (SQLSTATE 40001) when the recipient
-- opened another unpaid order between the plain read and the locks, which the caller may retry.
--
-- A refund in flight (user decision 2026-11-01): an entry with a refund row on one of its lines
-- (entry or extra) that dpay has not settled (dpay_status pending: reserved, claimed or awaiting
-- the answer; or unknown) is refund_pending for create_transfer, the accept of an open invite and
-- organizer_transfer. Otherwise the lines would move to the new holder and an accepted refund would
-- then cancel the new holder's entry. A refund already accepted, rejected or refused for balance is
-- settled and changes nothing here. apply_transfer reads it with the order and the lines locked, and
-- reserve_organizer_refund takes the order lock first, so the two serialize.

-- Grants: the four entry points are SECURITY DEFINER for service_role only; apply_transfer runs as
-- its caller and nobody may execute it. CREATE OR REPLACE keeps cancel_registration's grants.

-- ---------------------------------------------------------------- registration_refund_in_flight

-- True while a refund of one of the registration's lines waits for dpay (see the header).
CREATE FUNCTION public.registration_refund_in_flight(p_registration_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.refunds f JOIN public.order_lines l ON l.id = f.order_line_id
     WHERE l.registration_id = p_registration_id AND f.dpay_status IN ('pending', 'unknown'))
$$;
REVOKE EXECUTE ON FUNCTION public.registration_refund_in_flight(uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- create_transfer

-- p_now is for the tests' boundary instants (V-44); callers leave it out.
CREATE FUNCTION public.create_transfer(p_registration_id uuid, p_actor uuid, p_to_email text, p_token_hash text,
                                       p_now timestamptz DEFAULT now())
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r       public.registrations%ROWTYPE;
  v_rs    public.registration_settings%ROWTYPE;
  v_team  public.teams%ROWTYPE;
  v_email text := lower(btrim(p_to_email));
  v_mine  boolean;
  v_id    uuid;
  v_exp   timestamptz;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF r.team_id IS NOT NULL THEN
    SELECT * INTO v_team FROM public.teams WHERE id = r.team_id;
  END IF;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id;

  -- Ruling 3: the holder's own adult entry, or a team captain's. A guardian or a captain asking for
  -- a child's or a member's entry is told it cannot be transferred; anybody else is not the owner.
  v_mine := r.profile_id IS NOT NULL AND r.profile_id = p_actor;
  IF NOT v_mine
     AND (r.guardian_profile_id IS NULL OR r.guardian_profile_id IS DISTINCT FROM p_actor)
     AND (r.team_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.registrations c
             WHERE c.id = v_team.captain_registration_id AND c.profile_id = p_actor)) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  IF NOT v_mine
     OR r.status <> 'confirmed'
     OR r.email IS NULL OR r.guardian_profile_id IS NOT NULL
     OR r.birth_date IS NULL OR r.birth_date > (v_rs.event_date - interval '18 years')::date
     OR (r.team_id IS NOT NULL AND v_team.captain_registration_id IS DISTINCT FROM r.id) THEN
    RAISE EXCEPTION 'not_transferable';
  END IF;

  IF NOT v_rs.transfer_enabled OR v_rs.transfer_until IS NULL
     OR (p_now AT TIME ZONE 'Europe/Warsaw')::date > v_rs.transfer_until THEN
    RAISE EXCEPTION 'transfer_off';
  END IF;
  IF public.registration_refund_in_flight(r.id) THEN
    RAISE EXCEPTION 'refund_pending';
  END IF;
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  IF v_email = lower(btrim(r.email)) THEN
    RAISE EXCEPTION 'same_person';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_token';
  END IF;

  -- An invite whose link died is no longer pending (m-2): it would otherwise block a new one with
  -- pending_exists after the organizer moved transfer_until later. Under the registration lock.
  UPDATE public.transfers SET status = 'expired'
   WHERE registration_id = r.id AND status = 'pending' AND expires_at <= p_now;

  -- Ruling 4: valid through 23:59:59.999 Warsaw on transfer_until.
  v_exp := ((v_rs.transfer_until + 1)::timestamp AT TIME ZONE 'Europe/Warsaw');
  BEGIN
    INSERT INTO public.transfers (event_id, registration_id, kind, from_profile_id, to_email, token_hash, expires_at)
    VALUES (r.event_id, r.id, 'runner', p_actor, v_email, p_token_hash, v_exp)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM LIKE '%transfers_registration_pending_key%' THEN
        RAISE EXCEPTION 'pending_exists';
      END IF;
      RAISE EXCEPTION 'invalid_token';
    WHEN check_violation THEN
      RAISE EXCEPTION 'invalid_email';
  END;
  RETURN jsonb_build_object('transferId', v_id, 'expiresAt', v_exp);
END $$;
REVOKE EXECUTE ON FUNCTION public.create_transfer(uuid, uuid, text, text, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_transfer(uuid, uuid, text, text, timestamptz) TO service_role;

-- ---------------------------------------------------------------- cancel_transfer

-- true when this call cancelled the invite; false when it was no longer pending (accepted,
-- cancelled or expired meanwhile). Only the person who sent it may take it back.
CREATE FUNCTION public.cancel_transfer(p_transfer_id uuid, p_actor uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  t public.transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.transfers WHERE id = p_transfer_id;
  IF NOT FOUND OR t.kind <> 'runner' THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF t.from_profile_id IS NULL OR t.from_profile_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  -- The registration first: an accept holds it while it decides.
  PERFORM 1 FROM public.registrations WHERE id = t.registration_id FOR UPDATE;
  UPDATE public.transfers SET status = 'cancelled', cancelled_at = now()
   WHERE id = p_transfer_id AND status = 'pending'
  RETURNING * INTO t;
  RETURN FOUND;
END $$;
REVOKE EXECUTE ON FUNCTION public.cancel_transfer(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_transfer(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------- apply_transfer (internal)

-- p_person: the recipient as the forms send a person (firstName, lastName, email, birthDate, gender,
-- phone, city, club, iceName, icePhone, nationality, ageGroupLabel). p_kind 'runner': the recipient
-- accepts for themself (p_profile_id is their account, p_consent { consentIds, serviceRegulamin,
-- ip, userAgent }), consent_state 'accepted'. p_kind 'organizer': typed in by p_actor, consent_state
-- 'awaiting' (Plan 4's consent request follows). p_actor is registered_by_profile_id.
-- p_transfer_id: the invite an accept answers; checked once the locks are held, so a used, cancelled
-- or expired link answers gone before anything else.
CREATE FUNCTION public.apply_transfer(p_registration_id uuid, p_person jsonb, p_category_id uuid,
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
    SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
      FROM jsonb_array_elements_text(coalesce(p_consent->'consentIds', '[]'::jsonb)) AS t(x);
    SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
      FROM public.event_consents ec WHERE ec.event_id = r.event_id;
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

-- ---------------------------------------------------------------- accept_transfer

-- p_person is the recipient (their e-mail is the session's), p_profile_id their account,
-- p_consent { consentIds, serviceRegulamin } as the form sent it, p_meta { ip, userAgent }.
-- → { registrationId, senderProfileId, senderEmail, transferId }.
CREATE FUNCTION public.accept_transfer(p_token_hash text, p_person jsonb, p_category_id uuid, p_profile_id uuid,
                                       p_consent jsonb, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  t     public.transfers%ROWTYPE;
  v_out jsonb;
BEGIN
  -- Without a lock: only which registration to lock.
  SELECT * INTO t FROM public.transfers WHERE token_hash = p_token_hash AND kind = 'runner';
  IF NOT FOUND OR t.status <> 'pending' THEN
    RAISE EXCEPTION 'gone';
  END IF;

  v_out := public.apply_transfer(
    t.registration_id, p_person, p_category_id, p_profile_id,
    coalesce(p_consent, '{}'::jsonb) || jsonb_build_object('ip', p_meta->>'ip', 'userAgent', p_meta->>'userAgent'),
    'runner', p_profile_id, t.id);

  -- The gate: the write is the check. A link used, cancelled or expired meanwhile undoes it all.
  UPDATE public.transfers
     SET status = 'accepted', accepted_at = now(), accepted_by_profile_id = p_profile_id,
         new_registration_id = (v_out->>'registrationId')::uuid
   WHERE token_hash = p_token_hash AND status = 'pending' AND expires_at > now()
  RETURNING * INTO t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gone';
  END IF;

  RETURN jsonb_build_object('registrationId', v_out->'registrationId', 'senderProfileId', v_out->'senderProfileId',
                            'senderEmail', v_out->'senderEmail', 'transferId', t.id,
                            'hostWithdraw', v_out->'hostWithdraw');
END $$;
REVOKE EXECUTE ON FUNCTION public.accept_transfer(text, jsonb, uuid, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_transfer(text, jsonb, uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------- organizer_transfer

-- Ruling 4: after transfer_until the organizer transfers from B3, until 00:00 Warsaw on the race
-- day, with the same rules. The recipient has accepted nothing yet: consent_state 'awaiting', and
-- the caller issues Plan 4's consent request. A pending runner invite of the entry is cancelled.
-- p_now is for the tests' boundary instants (V-48); callers leave it out.
CREATE FUNCTION public.organizer_transfer(p_registration_id uuid, p_person jsonb, p_category_id uuid, p_actor uuid,
                                          p_now timestamptz DEFAULT now())
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r      public.registrations%ROWTYPE;
  v_date date;
  v_out  jsonb;
  v_id   uuid;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT event_date INTO v_date FROM public.registration_settings WHERE event_id = r.event_id;
  IF v_date IS NULL OR p_now >= (v_date::timestamp AT TIME ZONE 'Europe/Warsaw') THEN
    RAISE EXCEPTION 'race_day';
  END IF;

  v_out := public.apply_transfer(p_registration_id, p_person, p_category_id, NULL, NULL, 'organizer', p_actor, NULL);

  -- Last in the lock order: the invite that can no longer be accepted, then the record.
  UPDATE public.transfers SET status = 'cancelled', cancelled_at = now()
   WHERE registration_id = p_registration_id AND status = 'pending';
  INSERT INTO public.transfers (event_id, registration_id, kind, from_profile_id, to_email, status,
                                new_registration_id, accepted_at)
  VALUES (r.event_id, r.id, 'organizer', r.profile_id, lower(btrim(p_person->>'email')), 'accepted',
          (v_out->>'registrationId')::uuid, now())
  RETURNING id INTO v_id;

  RETURN v_out || jsonb_build_object('transferId', v_id, 'consentState', 'awaiting');
END $$;
REVOKE EXECUTE ON FUNCTION public.organizer_transfer(uuid, jsonb, uuid, uuid, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organizer_transfer(uuid, jsonb, uuid, uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------- cancel_registration (from 20261103130000)

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

  -- Unpaid: the whole order goes (ruling 6). It held no slot (P3-R15); cancel_order gives its
  -- voucher uses and stock back (D7-18).
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
    RAISE EXCEPTION '%', CASE WHEN r.status = 'cancelled' THEN 'already_cancelled'
                              WHEN r.status = 'transferred_out' THEN 'transferred' ELSE 'not_live' END;
  END IF;

  -- Confirmed: the locks in the Global Constraints order. Plan 2's free path has no order.
  IF r.order_id IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = r.order_id FOR UPDATE;
  END IF;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = r.category_id FOR UPDATE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = r.event_id FOR SHARE;
  IF r.team_id IS NOT NULL THEN
    SELECT * INTO v_team FROM public.teams WHERE id = r.team_id FOR UPDATE;
  END IF;
  -- Plan 7: the vouchers this cancel may give a use back to, before the registrations (id order).
  PERFORM 1 FROM public.vouchers v
   WHERE v.id IN (SELECT x.voucher_id FROM public.registrations x
                   WHERE CASE WHEN r.team_id IS NOT NULL THEN x.team_id = r.team_id AND x.status = ANY (c_live)
                              ELSE x.id = r.id END)
   ORDER BY v.id
     FOR UPDATE;
  IF r.team_id IS NOT NULL THEN
    PERFORM 1 FROM public.registrations WHERE team_id = r.team_id AND status = ANY (c_live) ORDER BY id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.registrations WHERE id = r.id FOR UPDATE;
  END IF;
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id;
  IF r.status <> 'confirmed' THEN
    -- A transfer that won the lock answers the same as one seen by the plain read (m-5).
    RAISE EXCEPTION '%', CASE WHEN r.status = 'transferred_out' THEN 'transferred' ELSE 'already_cancelled' END;
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

  -- The slot first (D6-26), then the voucher uses (Plan 7; the extras stay sold, §14.11), then the
  -- flip; a flip that finds nothing rolls both releases back.
  IF v_whole THEN
    UPDATE public.competitions SET taken = taken - 1 WHERE category_id = r.category_id;
  END IF;
  PERFORM public.release_registration_vouchers(ARRAY(
    SELECT x.id FROM public.registrations x WHERE x.id = ANY (v_targets) AND x.status = 'confirmed'));
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
    -- Plan 7 task 6: an invite of a cancelled entry dies with it (transfers last in the lock order).
    UPDATE public.transfers SET status = 'cancelled', cancelled_at = now()
     WHERE registration_id = ANY (v_done) AND status = 'pending';
    RETURN jsonb_build_object('cancelled', to_jsonb(v_done), 'hostWithdraw', false);
  END IF;

  -- Plan 7 task 6: an invite of a cancelled entry dies with it (transfers last in the lock order).
  UPDATE public.transfers SET status = 'cancelled', cancelled_at = now()
   WHERE registration_id = ANY (v_done) AND status = 'pending';

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
