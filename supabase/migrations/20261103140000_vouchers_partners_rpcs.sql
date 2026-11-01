-- Plan 7, task 5: the organizer's writes on vouchers and partners (organizer-vouchers) and the
-- partner of one entry (organizer-entry-action `partner`, B3).
--
-- Ruling 11: vouchers and partners are not pending changes. They apply at once, in draft and after
-- publish, since they never change what anyone already paid. `percent` and `code` are immutable
-- once `used > 0`, `max_uses` never goes below `used` (vouchers_used_within_max), and a voucher is
-- deleted only while nothing references it (else „Wyłącz”, organizer-vouchers `disable`).
--
--   create_vouchers           one or many vouchers (a code typed by the organizer, or a generated
--                             batch of up to 200) with their competition links, all or nothing
--   update_voucher            the fields the organizer sent, under the voucher's row lock, so a
--                             claim landing meanwhile is seen (the claim's UPDATE takes the same lock)
--   set_registration_partner  the partner of one live entry, set by hand or cleared
--
-- Lock order (Global Constraints): competitions → registration_settings → vouchers → registrations.
-- A voucher_competitions INSERT takes FOR KEY SHARE on its competition through the foreign key, and
-- that conflicts with the FOR UPDATE create_order and publish_changes hold. So create_vouchers and
-- update_voucher take the competitions they name FOR KEY SHARE, in category_id order, before any
-- other row lock: taken at the INSERT, after the voucher or the settings, they deadlock a sale or a
-- publish (V-36). set_registration_partner locks the registration alone.
--
-- Refusals are the exception message, mapped by the edge functions:
--   not_found, invalid_count, invalid_code, invalid_percent, invalid_max_uses, invalid_note,
--   invalid_category, invalid_partner, code_taken, voucher_used, below_used, not_live.
-- SECURITY DEFINER, search_path '', EXECUTE for service_role only.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------- create_vouchers

-- p_items: [{ code, percent, max_uses, valid_until, partner_id, note, category_ids }], as
-- validateVoucherInput (vouchers.js) leaves them; the checks here repeat its rules so a caller
-- skipping it cannot store anything the table would not, and name the field that failed.
CREATE FUNCTION public.create_vouchers(p_event_id uuid, p_items jsonb, p_actor uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_item    jsonb;
  v_code    text;
  v_id      uuid;
  v_partner uuid;
  v_cat     uuid;
  v_n       integer := 0;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'invalid_count';
  END IF;
  -- Competitions first: see the lock order above.
  PERFORM 1 FROM public.competitions k
   WHERE k.category_id IN (SELECT (c.value)::uuid
                             FROM jsonb_array_elements(p_items) i,
                                  jsonb_array_elements_text(coalesce(i.value->'category_ids', '[]'::jsonb)) c)
   ORDER BY k.category_id FOR KEY SHARE;
  -- FOR SHARE: a draft delete of the event (FOR UPDATE) waits for the batch, or the batch for it.
  PERFORM 1 FROM public.registration_settings rs WHERE rs.event_id = p_event_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_code := public.registration_normalize_code(v_item->>'code');
    IF v_code IS NULL THEN
      RAISE EXCEPTION 'invalid_code';
    END IF;
    IF jsonb_typeof(v_item->'percent') IS DISTINCT FROM 'number'
       OR (v_item->>'percent')::numeric NOT BETWEEN 1 AND 100
       OR (v_item->>'percent')::numeric <> trunc((v_item->>'percent')::numeric) THEN
      RAISE EXCEPTION 'invalid_percent';
    END IF;
    IF jsonb_typeof(v_item->'max_uses') IS DISTINCT FROM 'number'
       OR (v_item->>'max_uses')::numeric NOT BETWEEN 1 AND 100000
       OR (v_item->>'max_uses')::numeric <> trunc((v_item->>'max_uses')::numeric) THEN
      RAISE EXCEPTION 'invalid_max_uses';
    END IF;
    IF v_item->>'note' IS NOT NULL AND char_length(v_item->>'note') > 500 THEN
      RAISE EXCEPTION 'invalid_note';
    END IF;
    v_partner := nullif(v_item->>'partner_id', '')::uuid;
    IF v_partner IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.registration_partners p WHERE p.id = v_partner AND p.event_id = p_event_id) THEN
      RAISE EXCEPTION 'invalid_partner';
    END IF;

    BEGIN
      INSERT INTO public.vouchers (event_id, code, percent, max_uses, valid_until, partner_id, note, created_by)
      VALUES (p_event_id, v_code, (v_item->>'percent')::integer, (v_item->>'max_uses')::integer,
              nullif(v_item->>'valid_until', '')::timestamptz, v_partner, nullif(v_item->>'note', ''), p_actor)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'code_taken';
    END;

    FOR v_cat IN SELECT DISTINCT (c.value)::uuid
                   FROM jsonb_array_elements_text(coalesce(v_item->'category_ids', '[]'::jsonb)) c LOOP
      IF NOT EXISTS (SELECT 1 FROM public.competitions k WHERE k.category_id = v_cat AND k.event_id = p_event_id) THEN
        RAISE EXCEPTION 'invalid_category';
      END IF;
      INSERT INTO public.voucher_competitions (voucher_id, category_id) VALUES (v_id, v_cat);
    END LOOP;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
REVOKE EXECUTE ON FUNCTION public.create_vouchers(uuid, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_vouchers(uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------- update_voucher

-- p_fields: any of code, percent, max_uses, valid_until, partner_id, note, category_ids (snake_case,
-- as validateVoucherInput leaves them); a key left out is kept. → { changed: [keys] }.
-- Ruling 11 under the row lock: a used code keeps its code and percent (voucher_used, unless the
-- value sent is the stored one), max_uses below used → below_used.
CREATE FUNCTION public.update_voucher(p_voucher_id uuid, p_fields jsonb, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v        public.vouchers%ROWTYPE;
  v_code   text;
  v_pct    integer;
  v_max    integer;
  v_cat    uuid;
  v_change text[] := '{}';
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_fields ? 'category_ids' AND jsonb_typeof(p_fields->'category_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_category';
  END IF;
  -- Competitions first: see the lock order above. Before the row is read, so this may lock another
  -- event's competition for the moment it takes to refuse it below.
  IF p_fields ? 'category_ids' THEN
    PERFORM 1 FROM public.competitions k
     WHERE k.category_id IN (SELECT (c.value)::uuid FROM jsonb_array_elements_text(p_fields->'category_ids') c)
     ORDER BY k.category_id FOR KEY SHARE;
  END IF;
  SELECT * INTO v FROM public.vouchers x WHERE x.id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_fields ? 'code' THEN
    v_code := public.registration_normalize_code(p_fields->>'code');
    IF v_code IS NULL THEN
      RAISE EXCEPTION 'invalid_code';
    END IF;
    IF v_code <> v.code THEN
      IF v.used > 0 THEN
        RAISE EXCEPTION 'voucher_used';
      END IF;
      v.code := v_code;
      v_change := array_append(v_change, 'code');
    END IF;
  END IF;

  IF p_fields ? 'percent' THEN
    IF jsonb_typeof(p_fields->'percent') IS DISTINCT FROM 'number'
       OR (p_fields->>'percent')::numeric NOT BETWEEN 1 AND 100
       OR (p_fields->>'percent')::numeric <> trunc((p_fields->>'percent')::numeric) THEN
      RAISE EXCEPTION 'invalid_percent';
    END IF;
    v_pct := (p_fields->>'percent')::integer;
    IF v_pct <> v.percent THEN
      IF v.used > 0 THEN
        RAISE EXCEPTION 'voucher_used';
      END IF;
      v.percent := v_pct;
      v_change := array_append(v_change, 'percent');
    END IF;
  END IF;

  IF p_fields ? 'max_uses' THEN
    IF jsonb_typeof(p_fields->'max_uses') IS DISTINCT FROM 'number'
       OR (p_fields->>'max_uses')::numeric NOT BETWEEN 1 AND 100000
       OR (p_fields->>'max_uses')::numeric <> trunc((p_fields->>'max_uses')::numeric) THEN
      RAISE EXCEPTION 'invalid_max_uses';
    END IF;
    v_max := (p_fields->>'max_uses')::integer;
    IF v_max < v.used THEN
      RAISE EXCEPTION 'below_used';
    END IF;
    IF v_max <> v.max_uses THEN
      v.max_uses := v_max;
      v_change := array_append(v_change, 'max_uses');
    END IF;
  END IF;

  IF p_fields ? 'valid_until' AND nullif(p_fields->>'valid_until', '')::timestamptz IS DISTINCT FROM v.valid_until THEN
    v.valid_until := nullif(p_fields->>'valid_until', '')::timestamptz;
    v_change := array_append(v_change, 'valid_until');
  END IF;

  IF p_fields ? 'partner_id' AND nullif(p_fields->>'partner_id', '')::uuid IS DISTINCT FROM v.partner_id THEN
    v.partner_id := nullif(p_fields->>'partner_id', '')::uuid;
    IF v.partner_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.registration_partners p WHERE p.id = v.partner_id AND p.event_id = v.event_id) THEN
      RAISE EXCEPTION 'invalid_partner';
    END IF;
    v_change := array_append(v_change, 'partner_id');
  END IF;

  IF p_fields ? 'note' AND nullif(p_fields->>'note', '') IS DISTINCT FROM v.note THEN
    IF char_length(p_fields->>'note') > 500 THEN
      RAISE EXCEPTION 'invalid_note';
    END IF;
    v.note := nullif(p_fields->>'note', '');
    v_change := array_append(v_change, 'note');
  END IF;

  BEGIN
    UPDATE public.vouchers AS x
       SET code = v.code, percent = v.percent, max_uses = v.max_uses, valid_until = v.valid_until,
           partner_id = v.partner_id, note = v.note
     WHERE x.id = v.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'code_taken';
  END;

  IF p_fields ? 'category_ids' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p_fields->'category_ids') c
       WHERE NOT EXISTS (SELECT 1 FROM public.competitions k
                          WHERE k.category_id = (c.value)::uuid AND k.event_id = v.event_id)) THEN
      RAISE EXCEPTION 'invalid_category';
    END IF;
    IF (SELECT coalesce(array_agg(vc.category_id ORDER BY vc.category_id), '{}')
          FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id)
       IS DISTINCT FROM
       (SELECT coalesce(array_agg(DISTINCT (c.value)::uuid ORDER BY (c.value)::uuid), '{}')
          FROM jsonb_array_elements_text(p_fields->'category_ids') c) THEN
      DELETE FROM public.voucher_competitions vc WHERE vc.voucher_id = v.id;
      FOR v_cat IN SELECT DISTINCT (c.value)::uuid FROM jsonb_array_elements_text(p_fields->'category_ids') c LOOP
        INSERT INTO public.voucher_competitions (voucher_id, category_id) VALUES (v.id, v_cat);
      END LOOP;
      v_change := array_append(v_change, 'category_ids');
    END IF;
  END IF;

  RETURN jsonb_build_object('changed', to_jsonb(v_change));
END $$;
REVOKE EXECUTE ON FUNCTION public.update_voucher(uuid, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_voucher(uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------- set_registration_partner

-- B3 „Partner”: the organizer attributes one live entry to a partner of the event (p_partner_id), or
-- clears it (null). A voucher's partner was copied onto its entries by create_order; this overrides
-- it for that one entry and touches no voucher. → { partnerId, changed }.
CREATE FUNCTION public.set_registration_partner(p_registration_id uuid, p_partner_id uuid, p_actor uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r public.registrations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.registrations x WHERE x.id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF r.status NOT IN ('pending_payment', 'confirmed') THEN
    RAISE EXCEPTION 'not_live';
  END IF;
  IF p_partner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.registration_partners p WHERE p.id = p_partner_id AND p.event_id = r.event_id) THEN
    RAISE EXCEPTION 'invalid_partner';
  END IF;
  IF r.partner_id IS NOT DISTINCT FROM p_partner_id THEN
    RETURN jsonb_build_object('partnerId', p_partner_id, 'changed', false);
  END IF;
  UPDATE public.registrations AS x SET partner_id = p_partner_id WHERE x.id = r.id;
  RETURN jsonb_build_object('partnerId', p_partner_id, 'changed', true);
END $$;
REVOKE EXECUTE ON FUNCTION public.set_registration_partner(uuid, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_registration_partner(uuid, uuid, uuid) TO service_role;
