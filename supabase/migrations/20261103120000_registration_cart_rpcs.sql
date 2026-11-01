-- Plan 7, task 4a: vouchers, extras and a donation in the orders a runner creates.
--
--   claim_registration_voucher   one use of a voucher (by the id the caller resolved, else by code),
--                                in one statement (§16): used + 1 only while
--                                used < max_uses, not disabled, not past valid_until and offered in
--                                the competition. Raises voucher_invalid (unknown, malformed or
--                                disabled), voucher_expired, voucher_category or voucher_used_up.
--   claim_extra_stock            qty of a variant, in one statement: sold + qty only while it stays
--                                within stock. false when it would not.
--   release_registration_vouchers  used − 1 per registration holding a voucher, in voucher-id order
--   release_order_stock          sold − qty per extra line of an order, in variant-id order
--                                (both for the release paths of task 4b; nothing here calls them)
--
-- create_order (from 20261101110000) and create_team_registration (from 20261101110000) are
-- re-created with three inputs more: a person's (a team's) voucherCode, a person's
-- extras [{ variantId, qty }] and p_meta.donation (grosze; 0 unless the event is a charity with
-- donations on, else donation_not_allowed). total = entry_total + extras_total + donation, with
-- the entry prices discounted (registration_discounted_price), as orders_amounts_add_up_check
-- requires. Nothing is payable to LESZY.RUN (2026-10-31). A free event (pricing_mode 'free')
-- takes an order when it has extras or a donation (ruling 7), and register_free refuses a code, an
-- extra with qty above 0 or a donation above 0 (not_free); all-zero extras and a zero donation still
-- register free. A code on an entry whose list price is 0 is refused (voucher_not_applicable:<index>,
-- controller ruling on M-2): it would spend a use and credit a partner for a 0 zł discount.
-- registration_group_insert (from 20261031100000) takes the list price, voucher and partner, so a
-- coded registration is written once.
--
-- Order of work (Global Constraints lock order: competitions by category_id → settings → teams →
-- vouchers by id → extra_variants by id → registrations):
--   1. the competitions FOR UPDATE and the settings FOR SHARE (registration_group_lock);
--   2. plain reads only: the tier and list prices, each extra (extra_unavailable:<index> when the
--      variant is not this event's, its order_until has passed or it is not offered in that
--      person's competition), each code resolved to its voucher (voucher_invalid / _expired /
--      _category / _used_up :<index> when the read already says so; voucher_not_applicable:<index>
--      on a 0 zł entry);
--   3. the totals, then paying_closed, too_many_pending and price_changed as before;
--   4. capacity (P3-R15): an order to be paid claims no slot and is refused with full:<categoryId>
--      when the confirmed entries plus its people pass the limit; a total-0 order is confirmed at
--      once and claims its slots here;
--   5. the voucher uses, in voucher-id order (then person order: the second person typing one
--      single-use code gets voucher_used_up:1). Each claim takes the id the plain read in step 2
--      resolved, so two orders always lock vouchers in the same order and a code edited in between
--      cannot swap in another voucher (or its partner);
--   6. the stock, in variant-id order (extra_sold_out:<index>);
--   7. the registrations (list_price from the frozen tier, price discounted, voucher_id and the
--      voucher's partner_id) and the lines: an entry line per person, an extra line per person and
--      variant (registration_id set, amount = price × qty), one donation line (registration_id
--      null).
-- A percent that changed between the read and the claim (an organizer edit while used = 0)
-- re-prices the order and answers price_changed:<total>.
-- <index> is 0-based, the person in p_people (create_order) or the member (create_team_registration;
-- the team's code is the team line, index 0), as duplicate:<index> is.
--
-- Grants: the four helpers are SECURITY DEFINER for service_role only; the internal helpers below
-- them run as their caller and nobody else may execute them. The create_order wrapper
-- (create_order(uuid, jsonb, …), 20261031150000) is unchanged: it calls the group function by
-- name and passes every refusal but full / duplicate through.

-- ---------------------------------------------------------------- codes

-- normalizeCode (vouchers.js): trimmed, 4–32 ASCII letters, digits and '-', at least one letter or
-- digit, upper case. null otherwise. The ASCII test runs before upper(), which folds non-ASCII.
CREATE FUNCTION public.registration_normalize_code(p_code text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT CASE WHEN btrim(p_code) ~ '^[A-Za-z0-9-]{4,32}$' AND btrim(p_code) ~ '[A-Za-z0-9]'
              THEN upper(btrim(p_code)) END
$$;
REVOKE EXECUTE ON FUNCTION public.registration_normalize_code(text) FROM public, anon, authenticated, service_role;

-- Why a code cannot be used now, from a plain read: the reason, or null when it can.
CREATE FUNCTION public.registration_voucher_refusal(v public.vouchers, p_category_id uuid) RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT CASE
    WHEN v.id IS NULL OR v.disabled_at IS NOT NULL THEN 'voucher_invalid'
    WHEN v.valid_until IS NOT NULL AND v.valid_until <= now() THEN 'voucher_expired'
    WHEN EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id)
         AND NOT EXISTS (SELECT 1 FROM public.voucher_competitions vc
                          WHERE vc.voucher_id = v.id AND vc.category_id = p_category_id) THEN 'voucher_category'
    WHEN v.used >= v.max_uses THEN 'voucher_used_up'
  END
$$;
REVOKE EXECUTE ON FUNCTION public.registration_voucher_refusal(public.vouchers, uuid) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- claims and releases

-- p_voucher_id: the voucher the caller's plain read resolved the code to. Given, the claim takes that
-- row and no other (the code may have been edited since, while used = 0), so the caller's id order
-- is the order rows are locked in and the partner is the one it read. Without it the code decides.
CREATE FUNCTION public.claim_registration_voucher(p_event_id uuid, p_code text, p_category_id uuid,
                                                  p_voucher_id uuid DEFAULT NULL,
                                                  OUT o_id uuid, OUT o_percent integer, OUT o_partner_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_code text := public.registration_normalize_code(p_code);
  v      public.vouchers%ROWTYPE;
BEGIN
  IF p_voucher_id IS NULL AND v_code IS NULL THEN
    RAISE EXCEPTION 'voucher_invalid';
  END IF;
  -- §16: the write is the check.
  UPDATE public.vouchers AS x SET used = x.used + 1
   WHERE x.event_id = p_event_id
     AND CASE WHEN p_voucher_id IS NOT NULL THEN x.id = p_voucher_id ELSE x.code = v_code END
     AND x.used < x.max_uses AND x.disabled_at IS NULL
     AND (x.valid_until IS NULL OR x.valid_until > now())
     AND (NOT EXISTS (SELECT 1 FROM public.voucher_competitions vc WHERE vc.voucher_id = x.id)
          OR EXISTS (SELECT 1 FROM public.voucher_competitions vc
                      WHERE vc.voucher_id = x.id AND vc.category_id = p_category_id))
  RETURNING x.id, x.percent, x.partner_id INTO o_id, o_percent, o_partner_id;
  IF FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO v FROM public.vouchers x
   WHERE x.event_id = p_event_id
     AND CASE WHEN p_voucher_id IS NOT NULL THEN x.id = p_voucher_id ELSE x.code = v_code END;
  RAISE EXCEPTION '%', coalesce(public.registration_voucher_refusal(v, p_category_id), 'voucher_used_up');
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_registration_voucher(uuid, text, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_registration_voucher(uuid, text, uuid, uuid) TO service_role;

CREATE FUNCTION public.claim_extra_stock(p_variant_id uuid, p_qty integer) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF p_qty IS NULL OR p_qty < 1 THEN
    RAISE EXCEPTION 'invalid_qty' USING ERRCODE = '22023';
  END IF;
  UPDATE public.extra_variants AS v SET sold = v.sold + p_qty
   WHERE v.id = p_variant_id AND v.sold + p_qty <= v.stock;
  RETURN FOUND;
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_extra_stock(uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_extra_stock(uuid, integer) TO service_role;

-- The caller decides which registrations leave live; this gives back their uses, one per row.
CREATE FUNCTION public.release_registration_vouchers(p_registration_ids uuid[]) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  u record;
BEGIN
  FOR u IN
    SELECT r.voucher_id, count(*)::integer AS n
      FROM public.registrations r
     WHERE r.id = ANY (p_registration_ids) AND r.voucher_id IS NOT NULL
     GROUP BY r.voucher_id ORDER BY r.voucher_id
  LOOP
    UPDATE public.vouchers AS v SET used = v.used - u.n WHERE v.id = u.voucher_id;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.release_registration_vouchers(uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_registration_vouchers(uuid[]) TO service_role;

-- Every extra line of the order gives its qty back. Only for an order whose stock it still holds
-- (an unpaid order leaving live); a refund never gives stock back (§14.11).
CREATE FUNCTION public.release_order_stock(p_order_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  u record;
BEGIN
  FOR u IN
    SELECT l.extra_variant_id, sum(l.qty)::integer AS n
      FROM public.order_lines l
     WHERE l.order_id = p_order_id AND l.kind = 'extra'
     GROUP BY l.extra_variant_id ORDER BY l.extra_variant_id
  LOOP
    UPDATE public.extra_variants AS v SET sold = v.sold - u.n WHERE v.id = u.extra_variant_id;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.release_order_stock(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_order_stock(uuid) TO service_role;

-- ---------------------------------------------------------------- shared internals of the two creates

-- p_meta.donation: absent or null is 0; else a whole number of grosze, 0 or 1–5 000 zł (ruling 7),
-- and above 0 only on a charity event with donations on.
CREATE FUNCTION public.registration_donation(p_rs public.registration_settings, p_meta jsonb) RETURNS integer
  LANGUAGE plpgsql
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_raw jsonb := p_meta->'donation';
  v     integer;
BEGIN
  IF v_raw IS NULL OR v_raw = 'null'::jsonb THEN
    RETURN 0;
  END IF;
  IF jsonb_typeof(v_raw) <> 'number' OR v_raw::text !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'invalid_amount:donation' USING ERRCODE = '22023';
  END IF;
  v := v_raw::text::integer;
  IF v <> 0 AND v NOT BETWEEN 100 AND 500000 THEN
    RAISE EXCEPTION 'invalid_amount:donation' USING ERRCODE = '22023';
  END IF;
  IF v > 0 AND NOT (p_rs.is_charity AND p_rs.donations_enabled) THEN
    RAISE EXCEPTION 'donation_not_allowed';
  END IF;
  RETURN v;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_donation(public.registration_settings, jsonb) FROM public, anon, authenticated, service_role;

-- Every person's extras checked by a plain read → [{ i, variantId, qty, price }] in variant-id,
-- then person, order (the order the stock is claimed in). A person's extras: absent, null or an
-- array of at most 20 { variantId, qty 0–10 }, each variant once; qty 0 is no line. A variant that
-- is not this event's, an extra past its order_until (Warsaw day) or one not offered in the
-- person's competition → extra_unavailable:<index>.
CREATE FUNCTION public.registration_extra_items(p_rs public.registration_settings, p_people jsonb) RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_today  date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_person jsonb;
  v_idx    bigint;
  v_x      jsonb;
  v_vid    uuid;
  v_qty    integer;
  v_seen   uuid[];
  v_extra  record;
  v_items  jsonb := '[]'::jsonb;
BEGIN
  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    CONTINUE WHEN v_person->'extras' IS NULL OR v_person->'extras' = 'null'::jsonb;
    IF jsonb_typeof(v_person->'extras') <> 'array' OR jsonb_array_length(v_person->'extras') > 20 THEN
      RAISE EXCEPTION 'invalid_people';
    END IF;
    v_seen := '{}';
    FOR v_x IN SELECT value FROM jsonb_array_elements(v_person->'extras') LOOP
      -- Nested, so nothing is cast before its shape is known (OR has no evaluation order).
      IF jsonb_typeof(v_x) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid_people';
      END IF;
      IF coalesce(v_x->>'variantId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR jsonb_typeof(v_x->'qty') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'invalid_people';
      END IF;
      IF (v_x->'qty')::text !~ '^[0-9]{1,2}$' THEN
        RAISE EXCEPTION 'invalid_people';
      END IF;
      v_vid := (v_x->>'variantId')::uuid;
      v_qty := (v_x->'qty')::text::integer;
      IF v_qty > 10 OR v_vid = ANY (v_seen) THEN
        RAISE EXCEPTION 'invalid_people';
      END IF;
      v_seen := v_seen || v_vid;
      CONTINUE WHEN v_qty = 0;
      SELECT e.id, e.price, e.order_until INTO v_extra
        FROM public.extra_variants v JOIN public.extras e ON e.id = v.extra_id
       WHERE v.id = v_vid AND e.event_id = p_rs.event_id;
      IF NOT FOUND OR v_extra.order_until < v_today
         OR (EXISTS (SELECT 1 FROM public.extra_competitions ec WHERE ec.extra_id = v_extra.id)
             AND NOT EXISTS (SELECT 1 FROM public.extra_competitions ec
                              WHERE ec.extra_id = v_extra.id
                                AND ec.category_id = (v_person->>'categoryId')::uuid)) THEN
        RAISE EXCEPTION 'extra_unavailable:%', v_idx - 1;
      END IF;
      v_items := v_items || jsonb_build_object('i', v_idx - 1, 'variantId', v_vid, 'qty', v_qty, 'price', v_extra.price);
    END LOOP;
  END LOOP;
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY (x->>'variantId')::uuid, (x->>'i')::integer)
                     FROM jsonb_array_elements(v_items) x), '[]'::jsonb);
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_extra_items(public.registration_settings, jsonb) FROM public, anon, authenticated, service_role;

-- The stock of the items above, in their order (variant id, then person).
CREATE FUNCTION public.registration_claim_extras(p_items jsonb) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_x jsonb;
BEGIN
  FOR v_x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF NOT public.claim_extra_stock((v_x->>'variantId')::uuid, (v_x->>'qty')::integer) THEN
      RAISE EXCEPTION 'extra_sold_out:%', v_x->>'i';
    END IF;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_claim_extras(jsonb) FROM public, anon, authenticated, service_role;

-- One voucher use with the person's index on the refusal → (id, percent, partner_id).
CREATE FUNCTION public.registration_claim_voucher_at(p_event_id uuid, p_voucher_id uuid, p_code text, p_category_id uuid,
                                                     p_index integer,
                                                     OUT o_id uuid, OUT o_percent integer, OUT o_partner_id uuid)
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  SELECT c.o_id, c.o_percent, c.o_partner_id INTO o_id, o_percent, o_partner_id
    FROM public.claim_registration_voucher(p_event_id, p_code, p_category_id, p_voucher_id) c;
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM IN ('voucher_invalid', 'voucher_expired', 'voucher_category', 'voucher_used_up') THEN
    RAISE EXCEPTION '%:%', SQLERRM, p_index;
  END IF;
  RAISE;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_claim_voucher_at(uuid, uuid, text, uuid, integer) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- registration_group_insert (from 20261031100000)

-- M-5: a coded entry is written once, with its list price, discounted price, voucher and partner.
-- Three trailing parameters, defaulted, so the 11-argument callers (register_free, team_squad_insert)
-- resolve to it unchanged; the old signature is dropped so no call is ambiguous. p_list_price null
-- means the list price is p_price, as before.
DROP FUNCTION public.registration_group_insert(public.registration_settings, jsonb, integer, uuid, text, text,
  uuid, text, integer, inet, text);
CREATE FUNCTION public.registration_group_insert(
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
  IF v_role IN ('self', 'minor') THEN
    INSERT INTO public.consent_acceptances (
      registration_id, consent_id, consent_kind, accepted_by_profile_id, accepted_as, regulamin_version, ip, user_agent)
    SELECT v_reg, ec.id, ec.kind, p_profile_id, CASE WHEN v_role = 'minor' THEN 'guardian' ELSE 'self' END,
           CASE WHEN ec.kind = 'regulamin' THEN p_rs.regulamin_version END, p_ip, p_ua
      FROM public.event_consents ec WHERE ec.event_id = p_rs.event_id
    UNION ALL
    SELECT v_reg, NULL, 'service_regulamin', p_profile_id, CASE WHEN v_role = 'minor' THEN 'guardian' ELSE 'self' END,
           NULL, p_ip, p_ua;
  END IF;
  RETURN v_reg;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_group_insert(public.registration_settings, jsonb, integer, uuid, text, text,
  uuid, text, integer, inet, text, integer, uuid, uuid) FROM public, anon, authenticated, service_role;

-- true for an absent, null or zero amount: 0, 0.0, "0" or " 0 ". Anything else, malformed included,
-- is not zero.
CREATE FUNCTION public.registration_zero_amount(p_value jsonb) RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_value IS NULL OR p_value = 'null'::jsonb THEN true
    WHEN jsonb_typeof(p_value) = 'number' THEN p_value::text::numeric = 0
    WHEN jsonb_typeof(p_value) = 'string' AND btrim(p_value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN btrim(p_value #>> '{}')::numeric = 0
    ELSE false
  END
$$;
REVOKE EXECUTE ON FUNCTION public.registration_zero_amount(jsonb) FROM public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- register_free (from 20261101110000)

CREATE OR REPLACE FUNCTION public.register_free(p_people jsonb, p_profile_id uuid, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_lock   record;
  v_rs     public.registration_settings%ROWTYPE;
  v_cats   uuid[];
  v_person jsonb;
  v_idx    bigint;
  v_buyer  text;
  v_name   text;
  v_ip     inet;
  v_ua     text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_reg    uuid;
  v_regs   uuid[] := '{}';
  v_out    jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_lock FROM public.registration_group_lock(p_people, p_meta);
  v_rs := v_lock.o_settings;
  v_cats := v_lock.o_cats;
  IF EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = ANY (v_cats) AND c.kind = 'team') THEN
    RAISE EXCEPTION 'team_competition';
  END IF;
  IF v_rs.pricing_mode <> 'free' THEN
    RAISE EXCEPTION 'not_free';
  END IF;
  -- Ruling 7: a code, an extra or a donation is money, and money goes through create_order. The
  -- picker sends every extra row, at qty 0 when not taken, so only a row that is not a number 0
  -- counts; a donation is money unless it is absent, null or zero (0, 0.0, "0").
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_people) e
              WHERE nullif(btrim(e->>'voucherCode'), '') IS NOT NULL
                 OR (e->'extras' IS NOT NULL AND e->'extras' <> 'null'::jsonb
                     AND (jsonb_typeof(e->'extras') <> 'array'
                          OR EXISTS (SELECT 1 FROM jsonb_array_elements(e->'extras') x
                                      WHERE CASE WHEN jsonb_typeof(x) = 'object' AND jsonb_typeof(x->'qty') = 'number'
                                                 THEN (x->>'qty')::numeric <> 0 ELSE true END))))
     OR NOT public.registration_zero_amount(p_meta->'donation') THEN
    RAISE EXCEPTION 'not_free';
  END IF;

  SELECT lower(btrim(p.email)) INTO v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  -- A child is registered by a signed-in guardian, whose account it is attached to.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_people) e WHERE e->>'role' = 'minor')
     AND (v_buyer IS NULL OR v_buyer = '') THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     (SELECT btrim(concat_ws(' ', e->>'firstName', e->>'lastName'))
                        FROM jsonb_array_elements(p_people) e WHERE e->>'role' = 'self' LIMIT 1));

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, p_profile_id, v_buyer, v_name,
                                              NULL, 'confirmed', 0, v_ip, v_ua);
    v_regs := v_regs || v_reg;
  END LOOP;

  PERFORM public.registration_group_claim(p_people);

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_out := v_out || jsonb_build_object(
      'id', v_regs[v_idx], 'index', v_idx - 1, 'role', v_person->>'role',
      'categoryId', (v_person->>'categoryId')::uuid,
      'participantId', public.insert_registration_participant(v_regs[v_idx]));
  END LOOP;

  RETURN jsonb_build_object('registrations', v_out);
END $$;

-- ---------------------------------------------------------------- create_order (from 20261101110000)

CREATE OR REPLACE FUNCTION public.create_order(
  p_people jsonb, p_profile_id uuid, p_buyer_email text,
  p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_lock      record;
  v_rs        public.registration_settings%ROWTYPE;
  v_cats      uuid[];
  v_tier      uuid;
  v_tier_ends date;
  v_label     text;
  v_prices    jsonb := '{}'::jsonb;
  v_price     integer;
  v_entry     bigint := 0;
  v_total     bigint;
  v_free      boolean;
  v_buyer     text;
  v_profile   uuid;
  v_name      text;
  v_order     uuid;
  v_expires   timestamptz;
  v_person    jsonb;
  v_idx       bigint;
  v_reg       uuid;
  v_regs      uuid[] := '{}';
  v_out       jsonb := '[]'::jsonb;
  v_ip        inet;
  v_ua        text := left(nullif(p_meta->>'userAgent', ''), 500);
  u           record;
  v_n         integer;
  v_cat       uuid[];
  v_list      integer[];
  v_code      text[];
  v_vid       uuid[];
  v_pct       integer[];
  v_partner   uuid[];
  v_voucher   public.vouchers%ROWTYPE;
  v_refusal   text;
  v_claim     record;
  v_items     jsonb;
  v_x         jsonb;
  v_extras    bigint := 0;
  v_donation  integer;
BEGIN
  IF jsonb_typeof(p_people) IS DISTINCT FROM 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  -- P3-R4: an order belongs to a signed-in account, and its buyer address is that
  -- account's address. p_buyer_email is only checked against it.
  SELECT p.id, lower(btrim(p.email)) INTO v_profile, v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  IF v_profile IS NULL OR v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_buyer_email IS NOT NULL AND lower(btrim(p_buyer_email)) IS DISTINCT FROM v_buyer THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;

  -- D3-1: the competitions (category_id order), then the settings.
  SELECT * INTO v_lock FROM public.registration_group_lock(p_people, p_meta);
  v_rs := v_lock.o_settings;
  v_cats := v_lock.o_cats;
  IF EXISTS (SELECT 1 FROM public.competitions c WHERE c.category_id = ANY (v_cats) AND c.kind = 'team') THEN
    RAISE EXCEPTION 'team_competition';
  END IF;

  -- Plain reads from here to the claims: the donation, the extras, the codes.
  v_n := jsonb_array_length(p_people);
  v_donation := public.registration_donation(v_rs, p_meta);
  v_items := public.registration_extra_items(v_rs, p_people);
  -- Ruling 7: a free event takes an order only for extras or a donation.
  IF v_rs.pricing_mode = 'free' AND jsonb_array_length(v_items) = 0 AND v_donation = 0 THEN
    RAISE EXCEPTION 'free_event';
  END IF;

  -- The current tier; every person at their own competition's price in it (0 on a free event).
  -- v_prices is keyed by the canonical uuid text, so every lookup casts the person's
  -- categoryId through uuid (an uppercase id prices like a lowercase one).
  IF v_rs.pricing_mode <> 'free' THEN
    SELECT t.o_id, t.o_ends_on, t.o_label INTO v_tier, v_tier_ends, v_label
      FROM public.registration_current_tier(v_rs.event_id) t;
  END IF;
  FOR u IN SELECT c AS category_id FROM unnest(v_cats) AS c LOOP
    v_price := CASE WHEN v_rs.pricing_mode = 'free' THEN 0 ELSE public.registration_current_price(u.category_id) END;
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
    v_prices := v_prices || jsonb_build_object(u.category_id::text, v_price);
  END LOOP;

  v_cat := array_fill(NULL::uuid, ARRAY[v_n]);
  v_list := array_fill(NULL::integer, ARRAY[v_n]);
  v_code := array_fill(NULL::text, ARRAY[v_n]);
  v_vid := array_fill(NULL::uuid, ARRAY[v_n]);
  v_pct := array_fill(NULL::integer, ARRAY[v_n]);
  v_partner := array_fill(NULL::uuid, ARRAY[v_n]);
  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_cat[v_idx] := (v_person->>'categoryId')::uuid;
    v_list[v_idx] := (v_prices->>(v_cat[v_idx]::text))::integer;
    CONTINUE WHEN nullif(btrim(v_person->>'voucherCode'), '') IS NULL;
    v_code[v_idx] := public.registration_normalize_code(v_person->>'voucherCode');
    v_voucher := NULL;
    IF v_code[v_idx] IS NOT NULL THEN
      SELECT * INTO v_voucher FROM public.vouchers x WHERE x.event_id = v_rs.event_id AND x.code = v_code[v_idx];
    END IF;
    v_refusal := public.registration_voucher_refusal(v_voucher, v_cat[v_idx]);
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION '%:%', v_refusal, v_idx - 1;
    END IF;
    -- A code discounts nothing on a 0 zł entry: refused, so no use is spent and no partner credited.
    IF v_list[v_idx] = 0 THEN
      RAISE EXCEPTION 'voucher_not_applicable:%', v_idx - 1;
    END IF;
    v_vid[v_idx] := v_voucher.id;
    v_pct[v_idx] := v_voucher.percent;
  END LOOP;

  FOR v_idx IN 1 .. v_n LOOP
    v_entry := v_entry + public.registration_discounted_price(v_list[v_idx], v_pct[v_idx]);
  END LOOP;
  SELECT coalesce(sum((x->>'price')::bigint * (x->>'qty')::bigint), 0) INTO v_extras FROM jsonb_array_elements(v_items) x;
  v_total := v_entry + v_extras + v_donation;
  IF v_total > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- At most two payable orders per account and event; a group is one order.
  PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
  IF (SELECT count(*) FROM public.orders o
       WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
         AND o.buyer_profile_id = v_profile) >= 2 THEN
    RAISE EXCEPTION 'too_many_pending';
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  -- P3-R15: an order waiting for payment claims nothing; it is refused when the paid
  -- entries plus the group's people in a competition pass its limit. A 0 zł order is
  -- confirmed here, so it claims now, as register_free does.
  IF v_free THEN
    PERFORM public.registration_group_claim(p_people);
  ELSE
    FOR u IN
      SELECT c.category_id FROM public.competitions c
        JOIN (SELECT (e->>'categoryId')::uuid AS category_id, count(*) AS n
                FROM jsonb_array_elements(p_people) AS e GROUP BY 1) g ON g.category_id = c.category_id
       WHERE c.taken + g.n > c.capacity
       ORDER BY c.category_id LIMIT 1
    LOOP
      RAISE EXCEPTION 'full:%', u.category_id;
    END LOOP;
  END IF;

  -- The voucher uses, in voucher-id order, then person order.
  FOR u IN SELECT t.i::integer AS i FROM unnest(v_vid) WITH ORDINALITY AS t(vid, i)
            WHERE t.vid IS NOT NULL ORDER BY t.vid, t.i LOOP
    SELECT * INTO v_claim FROM public.registration_claim_voucher_at(v_rs.event_id, v_vid[u.i], v_code[u.i], v_cat[u.i], u.i - 1);
    v_vid[u.i] := v_claim.o_id;
    v_pct[u.i] := v_claim.o_percent;
    v_partner[u.i] := v_claim.o_partner_id;
  END LOOP;
  -- A percent edited between the read and the claim re-prices the order.
  IF (SELECT sum(public.registration_discounted_price(v_list[i], v_pct[i])) FROM generate_series(1, v_n) i) <> v_entry THEN
    RAISE EXCEPTION 'price_changed:%',
      (SELECT sum(public.registration_discounted_price(v_list[i], v_pct[i])) FROM generate_series(1, v_n) i)
      + v_extras + v_donation;
  END IF;

  -- The stock, in variant-id order.
  PERFORM public.registration_claim_extras(v_items);

  v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                    ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
  INSERT INTO public.orders (
    event_id, buyer_profile_id, buyer_email, status, entry_total, extras_total, donation,
    total, tier_id, expires_at, paid_at)
  VALUES (
    v_rs.event_id, v_profile, v_buyer, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_entry, v_extras, v_donation,
    v_total, v_tier, v_expires, CASE WHEN v_free THEN now() END)
  RETURNING id INTO v_order;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     (SELECT btrim(concat_ws(' ', e->>'firstName', e->>'lastName'))
                        FROM jsonb_array_elements(p_people) e WHERE e->>'role' = 'self' LIMIT 1));

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_price := public.registration_discounted_price(v_list[v_idx], v_pct[v_idx]);
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, v_profile, v_buyer, v_name,
                                              v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
                                              v_price, v_ip, v_ua, v_list[v_idx], v_vid[v_idx], v_partner[v_idx]);
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_reg, 1, v_price, v_label, v_tier_ends);
    v_regs := v_regs || v_reg;
  END LOOP;

  FOR v_x IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    INSERT INTO public.order_lines (order_id, kind, registration_id, extra_variant_id, qty, amount)
    VALUES (v_order, 'extra', v_regs[(v_x->>'i')::integer + 1], (v_x->>'variantId')::uuid, (v_x->>'qty')::integer,
            (v_x->>'price')::integer * (v_x->>'qty')::integer);
  END LOOP;
  IF v_donation > 0 THEN
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
    VALUES (v_order, 'donation', NULL, 1, v_donation);
  END IF;

  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_people) WITH ORDINALITY LOOP
    v_out := v_out || jsonb_build_object(
      'id', v_regs[v_idx], 'index', v_idx - 1, 'role', v_person->>'role',
      'categoryId', (v_person->>'categoryId')::uuid,
      'participantId', CASE WHEN v_free THEN public.insert_registration_participant(v_regs[v_idx]) END);
  END LOOP;

  RETURN jsonb_build_object(
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'paid' ELSE 'pending' END,
    'total', v_total,
    'amounts', jsonb_build_object(
      'entryTotal', v_entry, 'extrasTotal', v_extras, 'donation', v_donation, 'total', v_total),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;

-- ---------------------------------------------------------------- create_team_registration (from 20261101110000)

-- p_members: member 0 is the captain, { role: self|adult|minor, leg?, extras?, …person }, as
-- validateTeam hands them over. p_meta.voucherCode is the team line's code (the captain's
-- registration carries it), p_meta.donation the order's donation. The edge function validates the
-- members; the shape, the size and the captain are checked again here, because a wrong call would
-- otherwise store acceptances nobody gave.
-- → { teamId, orderId|null, status: confirmed|pending, total, amounts, expiresAt,
--     registrations: [{ id, index, role }] }
CREATE OR REPLACE FUNCTION public.create_team_registration(
  p_category_id uuid, p_team_name text, p_members jsonb, p_profile_id uuid, p_buyer_email text,
  p_displayed_total integer, p_meta jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_comp      public.competitions%ROWTYPE;
  v_rs        public.registration_settings%ROWTYPE;
  v_people    jsonb;
  v_n         integer;
  v_buyer     text;
  v_profile   uuid;
  v_paid      boolean;
  v_tier      uuid;
  v_tier_ends date;
  v_label     text;
  v_fee       integer := 0;
  v_free      boolean;
  v_expires   timestamptz;
  v_team      uuid;
  v_order     uuid;
  v_name      text;
  v_ip        inet;
  v_ua        text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_person    jsonb;
  v_idx       bigint;
  v_reg       uuid;
  v_regs      uuid[] := '{}';
  v_out       jsonb := '[]'::jsonb;
  v_list      integer := 0;
  v_code      text;
  v_voucher   public.vouchers%ROWTYPE;
  v_refusal   text;
  v_claim     record;
  v_voucher_id uuid;
  v_partner   uuid;
  v_items     jsonb;
  v_x         jsonb;
  v_extras    bigint := 0;
  v_donation  integer;
  v_total     bigint;
BEGIN
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array' OR jsonb_array_length(p_members) = 0 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  v_n := jsonb_array_length(p_members);
  IF nullif(btrim(p_team_name), '') IS NULL THEN
    RAISE EXCEPTION 'invalid_team_name';
  END IF;

  -- P3-R4: a team belongs to a signed-in account, the captain's, and the buyer address is that
  -- account's address. A free team needs it too: the captain is the guardian of the minors.
  SELECT p.id, lower(btrim(p.email)) INTO v_profile, v_buyer FROM public.profiles p WHERE p.id = p_profile_id;
  IF v_profile IS NULL OR v_buyer IS NULL OR v_buyer = '' THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_buyer_email IS NOT NULL AND lower(btrim(p_buyer_email)) IS DISTINCT FROM v_buyer THEN
    RAISE EXCEPTION 'invalid_buyer_email';
  END IF;

  -- D3-1: the competition, then the settings. The lock below takes the same row again.
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = p_category_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_comp.kind <> 'team' THEN
    RAISE EXCEPTION 'not_team';
  END IF;

  SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object'
                        THEN e || jsonb_build_object('categoryId', p_category_id) ELSE e END
                   ORDER BY i)
    INTO v_people FROM jsonb_array_elements(p_members) WITH ORDINALITY AS t(e, i);
  v_rs := (public.registration_group_lock(v_people, p_meta)).o_settings;

  IF v_comp.team_min IS NULL OR v_comp.team_max IS NULL OR v_n NOT BETWEEN v_comp.team_min AND v_comp.team_max THEN
    RAISE EXCEPTION 'team_size';
  END IF;
  -- The captain is the account, and the only 'self'.
  IF v_people->0->>'role' IS DISTINCT FROM 'self'
     OR lower(btrim(v_people->0->>'email')) IS DISTINCT FROM v_buyer
     OR (SELECT count(*) FROM jsonb_array_elements(v_people) e WHERE e->>'role' = 'self') <> 1 THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;
  IF v_comp.leg_order_enabled AND EXISTS (
    SELECT 1 FROM generate_series(1, v_n) AS leg
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_people) e WHERE e->>'leg' = leg::text)) THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  -- Plain reads: the donation, the members' extras, the team's code.
  v_donation := public.registration_donation(v_rs, p_meta);
  v_items := public.registration_extra_items(v_rs, v_people);
  v_code := nullif(btrim(p_meta->>'voucherCode'), '');
  -- An order exists when there is something to pay for: a priced event, extras or a donation
  -- (ruling 7). A code alone on a free event discounts nothing.
  v_paid := v_rs.pricing_mode <> 'free' OR jsonb_array_length(v_items) > 0 OR v_donation > 0;
  IF NOT v_paid AND v_code IS NOT NULL THEN
    RAISE EXCEPTION 'free_event';
  END IF;

  -- The fee is the competition's current price, less the team's code.
  IF v_rs.pricing_mode <> 'free' THEN
    SELECT t.o_id, t.o_ends_on, t.o_label INTO v_tier, v_tier_ends, v_label
      FROM public.registration_current_tier(v_rs.event_id) t;
    v_list := public.registration_current_price(p_category_id);
    IF v_list IS NULL THEN
      RAISE EXCEPTION 'no_price';
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    v_code := public.registration_normalize_code(v_code);
    v_voucher := NULL;
    IF v_code IS NOT NULL THEN
      SELECT * INTO v_voucher FROM public.vouchers x WHERE x.event_id = v_rs.event_id AND x.code = v_code;
    END IF;
    v_refusal := public.registration_voucher_refusal(v_voucher, p_category_id);
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION '%:0', v_refusal;
    END IF;
    IF v_list = 0 THEN
      RAISE EXCEPTION 'voucher_not_applicable:0';
    END IF;
  END IF;
  v_fee := public.registration_discounted_price(v_list, v_voucher.percent);
  SELECT coalesce(sum((x->>'price')::bigint * (x->>'qty')::bigint), 0) INTO v_extras FROM jsonb_array_elements(v_items) x;
  v_total := v_fee + v_extras + v_donation;
  IF v_total > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:total' USING ERRCODE = '22023';
  END IF;
  v_free := v_total = 0;

  -- Spec 14.10: online payment stops an hour before registration closes.
  IF NOT v_free AND now() >= v_rs.closes_at - interval '1 hour' THEN
    RAISE EXCEPTION 'paying_closed';
  END IF;

  -- One count across team and individual orders.
  IF v_paid THEN
    PERFORM pg_advisory_xact_lock(hashtext('create_order:' || v_profile::text || ':' || v_rs.event_id::text));
    IF (SELECT count(*) FROM public.orders o
         WHERE o.event_id = v_rs.event_id AND o.status = 'pending' AND o.expires_at > now()
           AND o.buyer_profile_id = v_profile) >= 2 THEN
      RAISE EXCEPTION 'too_many_pending';
    END IF;
  END IF;

  IF p_displayed_total IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'price_changed:%', v_total;
  END IF;

  -- P3-R15: a team takes one slot once it is confirmed. Waiting for payment it holds none and is
  -- refused when the confirmed entries already fill the limit.
  IF v_free THEN
    IF public.claim_competition_slots(p_category_id, 1) IS NULL THEN
      RAISE EXCEPTION 'full';
    END IF;
  ELSIF v_comp.taken >= v_comp.capacity THEN
    RAISE EXCEPTION 'full';
  END IF;

  BEGIN
    INSERT INTO public.teams (event_id, category_id, name)
    VALUES (v_rs.event_id, p_category_id, btrim(p_team_name))
    RETURNING id INTO v_team;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'team_name_taken';
  END;

  -- Lock order: teams → vouchers → extra_variants → registrations.
  IF v_code IS NOT NULL THEN
    SELECT * INTO v_claim FROM public.registration_claim_voucher_at(v_rs.event_id, v_voucher.id, v_code, p_category_id, 0);
    v_voucher_id := v_claim.o_id;
    v_partner := v_claim.o_partner_id;
    IF public.registration_discounted_price(v_list, v_claim.o_percent) <> v_fee THEN
      RAISE EXCEPTION 'price_changed:%', public.registration_discounted_price(v_list, v_claim.o_percent) + v_extras + v_donation;
    END IF;
  END IF;
  PERFORM public.registration_claim_extras(v_items);

  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     btrim(concat_ws(' ', v_people->0->>'firstName', v_people->0->>'lastName')));

  IF v_paid THEN
    v_expires := CASE WHEN v_rs.payment_window_until_close THEN v_rs.closes_at
                      ELSE least(now() + make_interval(hours => v_rs.payment_window_hours), v_rs.closes_at) END;
    INSERT INTO public.orders (
      event_id, buyer_profile_id, buyer_email, buyer_name, status, entry_total, extras_total, donation,
      total, tier_id, expires_at, paid_at)
    VALUES (
      v_rs.event_id, v_profile, v_buyer, v_name, CASE WHEN v_free THEN 'paid' ELSE 'pending' END, v_fee, v_extras,
      v_donation, v_total, v_tier, v_expires, CASE WHEN v_free THEN now() END)
    RETURNING id INTO v_order;
  END IF;

  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  -- Ruling 4: the fee sits on the captain; members carry 0 and have no order line.
  FOR v_person, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(v_people) WITH ORDINALITY LOOP
    v_reg := public.registration_group_insert(v_rs, v_person, (v_idx - 1)::integer, v_profile, v_buyer, v_name,
                                              v_order, CASE WHEN v_free THEN 'confirmed' ELSE 'pending_payment' END,
                                              CASE WHEN v_idx = 1 THEN v_fee ELSE 0 END, v_ip, v_ua,
                                              CASE WHEN v_idx = 1 THEN v_list ELSE 0 END,
                                              CASE WHEN v_idx = 1 THEN v_voucher_id END,
                                              CASE WHEN v_idx = 1 THEN v_partner END);
    UPDATE public.registrations
       SET team_id = v_team,
           team_leg = CASE WHEN v_comp.leg_order_enabled THEN (v_person->>'leg')::integer END,
           team_position = v_idx
     WHERE id = v_reg;
    v_regs := v_regs || v_reg;
    v_out := v_out || jsonb_build_object('id', v_reg, 'index', v_idx - 1, 'role', v_person->>'role');
  END LOOP;
  UPDATE public.teams SET captain_registration_id = v_regs[1] WHERE id = v_team;

  IF v_paid THEN
    INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount, tier_label, tier_ends_on)
    VALUES (v_order, 'entry', v_regs[1], 1, v_fee, v_label, v_tier_ends);
    FOR v_x IN SELECT value FROM jsonb_array_elements(v_items) LOOP
      INSERT INTO public.order_lines (order_id, kind, registration_id, extra_variant_id, qty, amount)
      VALUES (v_order, 'extra', v_regs[(v_x->>'i')::integer + 1], (v_x->>'variantId')::uuid, (v_x->>'qty')::integer,
              (v_x->>'price')::integer * (v_x->>'qty')::integer);
    END LOOP;
    IF v_donation > 0 THEN
      INSERT INTO public.order_lines (order_id, kind, registration_id, qty, amount)
      VALUES (v_order, 'donation', NULL, 1, v_donation);
    END IF;
  END IF;

  IF v_free THEN
    PERFORM public.insert_registration_participant(r) FROM unnest(v_regs) AS r;
  END IF;

  RETURN jsonb_build_object(
    'teamId', v_team,
    'orderId', v_order,
    'status', CASE WHEN v_free THEN 'confirmed' ELSE 'pending' END,
    'total', v_total,
    'amounts', jsonb_build_object('entryTotal', v_fee, 'extrasTotal', v_extras, 'donation', v_donation, 'total', v_total),
    'expiresAt', v_expires,
    'registrations', v_out);
END $$;
