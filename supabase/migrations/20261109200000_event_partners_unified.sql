-- Event partners: one table for the admin app, the wizard and the discount codes.
--
-- event_partners (the sponsor logos on event pages, written by the admin app) and
-- registration_partners (Plan 7's discount-code partners, organizer-only) become one table.
-- event_partners exists for every event, including events with no registration, which
-- registration_partners could not serve (its FK required registration_settings).
--
--   * event_partners gains note (organizer-only, ≤ 500), is_public (default true) and logo_path
--     (the storage path, so a delete never parses a URL; filled for existing logos from the part
--     of logo_url after /object/public/partner-logos/), registration_partners' name rule (1–80,
--     trimmed, unique per event on lower(name)) and a website_url rule (NULL or http(s), ≤ 500).
--     Existing rows that break a rule are repaired first, so the release never fails on them:
--     names are trimmed and cut to 80, a duplicate name in one event gets " (2)", " (3)" in
--     created_at order, a website without a scheme gets https://, anything else invalid is nulled.
--   * Every registration_partners row is copied with the same id and is_public = false (they were
--     never public and may be discount-only partners), after the event's own partners in
--     created_at order. On a name clash in the same event the admin row wins and keeps its
--     is_public; the codes and entries pointing at the registration partner are re-pointed to it,
--     and its note is filled from the registration partner's when it has none.
--   * vouchers.partner_id and registrations.partner_id reference event_partners (id, event_id),
--     ON DELETE RESTRICT, as they referenced registration_partners. The FKs are dropped before
--     the re-pointing (it would break them) and added back after the copy.
--   * create_vouchers, update_voucher, set_registration_partner (20261103140000) and
--     apply_transfer (20261105090000) are recreated from those bodies with registration_partners
--     renamed to event_partners and nothing else changed; the REVOKE / GRANT after each restates
--     the source migration's.
--   * Public access: anon and authenticated read only (id, event_id, name, logo_url, website_url,
--     sort_order) and only rows with is_public. note, is_public and logo_path are never theirs.
--     registrations.partner_id and vouchers.note stay organizer-only (no grant).
--   * Bucket partner-logos is created when missing (a fresh stack). Its public-read SELECT policy
--     on storage.objects is dropped: a public bucket serves an object by its URL without it, so
--     nothing visible breaks, but nobody can list the bucket and find a hidden partner's logo.
--     Stored SVG logos are left as they are.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------- 1. columns and checks

ALTER TABLE public.event_partners
  ADD COLUMN note text CONSTRAINT event_partners_note_check CHECK (char_length(note) <= 500),
  ADD COLUMN is_public boolean NOT NULL DEFAULT true,
  ADD COLUMN logo_path text;

-- Logos uploaded before logo_path existed: the path is the part of the public URL after the
-- bucket, kept as stored, so deleting or replacing such a logo removes its object too.
UPDATE public.event_partners
   SET logo_path = substr(logo_url, strpos(logo_url, '/object/public/partner-logos/') + length('/object/public/partner-logos/'))
 WHERE logo_path IS NULL
   AND strpos(logo_url, '/object/public/partner-logos/') > 0
   AND length(logo_url) > strpos(logo_url, '/object/public/partner-logos/') + length('/object/public/partner-logos/') - 1;

ALTER TABLE public.event_partners
  ADD CONSTRAINT event_partners_name_check
    CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)) NOT VALID,
  ADD CONSTRAINT event_partners_website_url_check
    CHECK (website_url IS NULL OR (website_url ~* '^https?://' AND char_length(website_url) <= 500)) NOT VALID;

-- The admin app trimmed nothing and capped nothing. An empty name becomes „Partner”.
UPDATE public.event_partners
   SET name = coalesce(nullif(btrim(left(btrim(name), 80)), ''), 'Partner')
 WHERE NOT (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name));

-- The admin app accepted any text as a link. „sklep.pl” is kept as https://sklep.pl (an
-- internationalised domain such as „sklep-łódź.pl” too: a label is anything but whitespace, „/”,
-- „:”, „.” and „@”); anything else that is not an http(s) address of at most 500 characters is dropped.
UPDATE public.event_partners
   SET website_url = CASE
         WHEN btrim(website_url) ~* '^https?://' AND char_length(btrim(website_url)) <= 500 THEN btrim(website_url)
         WHEN btrim(website_url) ~ '^[^\s/:.@]+(\.[^\s/:.@]+)+(/\S*)?$'
              AND char_length(btrim(website_url)) <= 492 THEN 'https://' || btrim(website_url)
         ELSE NULL
       END
 WHERE website_url IS NOT NULL
   AND NOT (website_url ~* '^https?://' AND char_length(website_url) <= 500);

ALTER TABLE public.event_partners VALIDATE CONSTRAINT event_partners_name_check;
ALTER TABLE public.event_partners VALIDATE CONSTRAINT event_partners_website_url_check;

-- ---------------------------------------------------------------- 2. one name per event

-- A later duplicate (created_at, id) is renamed „<name> (2)”, „(3)”, … skipping a name that is
-- already taken, here or by a registration partner of the same event (which section 3 would
-- otherwise merge into the renamed row), so the unique index below never fails the release.
DO $$
DECLARE
  r    record;
  k    integer;
  cand text;
BEGIN
  FOR r IN SELECT p.id, p.event_id, p.name,
                  row_number() OVER (PARTITION BY p.event_id, lower(p.name) ORDER BY p.created_at, p.id) AS n
             FROM public.event_partners p LOOP
    CONTINUE WHEN r.n = 1;
    k := r.n;
    LOOP
      cand := rtrim(left(r.name, 80 - char_length(' (' || k || ')'))) || ' (' || k || ')';
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.event_partners x
                             WHERE x.event_id = r.event_id AND lower(x.name) = lower(cand))
            AND NOT EXISTS (SELECT 1 FROM public.registration_partners rp
                             WHERE rp.event_id = r.event_id AND lower(rp.name) = lower(cand));
      k := k + 1;
    END LOOP;
    UPDATE public.event_partners SET name = cand WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX event_partners_event_name_key ON public.event_partners (event_id, lower(name));
ALTER TABLE public.event_partners ADD CONSTRAINT event_partners_id_event_id_key UNIQUE (id, event_id);

-- ---------------------------------------------------------------- 3. the codes' partners move in

ALTER TABLE public.vouchers DROP CONSTRAINT vouchers_partner_id_fkey;
ALTER TABLE public.registrations DROP CONSTRAINT registrations_partner_id_fkey;

-- A name clash: the admin row wins. Re-point what referenced the registration partner, and keep
-- its note where the admin row has none.
UPDATE public.vouchers v
   SET partner_id = ep.id
  FROM public.registration_partners rp
  JOIN public.event_partners ep ON ep.event_id = rp.event_id AND lower(ep.name) = lower(rp.name)
 WHERE v.partner_id = rp.id;

UPDATE public.registrations r
   SET partner_id = ep.id
  FROM public.registration_partners rp
  JOIN public.event_partners ep ON ep.event_id = rp.event_id AND lower(ep.name) = lower(rp.name)
 WHERE r.partner_id = rp.id;

UPDATE public.event_partners ep
   SET note = rp.note
  FROM public.registration_partners rp
 WHERE ep.event_id = rp.event_id AND lower(ep.name) = lower(rp.name)
   AND ep.note IS NULL AND rp.note IS NOT NULL;

-- No clash: the same id, hidden, after the event's own partners in created_at order.
INSERT INTO public.event_partners (id, event_id, name, note, is_public, sort_order, created_at)
SELECT rp.id, rp.event_id, rp.name, rp.note, false,
       coalesce(m.max_sort, -1) + row_number() OVER (PARTITION BY rp.event_id ORDER BY rp.created_at, rp.id),
       rp.created_at
  FROM public.registration_partners rp
  LEFT JOIN (SELECT event_id, max(sort_order) AS max_sort FROM public.event_partners GROUP BY event_id) m
         ON m.event_id = rp.event_id
 WHERE NOT EXISTS (SELECT 1 FROM public.event_partners ep
                    WHERE ep.event_id = rp.event_id AND lower(ep.name) = lower(rp.name));

-- ---------------------------------------------------------------- 4. foreign keys

ALTER TABLE public.vouchers
  ADD CONSTRAINT vouchers_partner_id_fkey FOREIGN KEY (partner_id, event_id)
    REFERENCES public.event_partners (id, event_id) ON DELETE RESTRICT;
ALTER TABLE public.registrations
  ADD CONSTRAINT registrations_partner_id_fkey FOREIGN KEY (partner_id, event_id)
    REFERENCES public.event_partners (id, event_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------- 5. functions naming the table

-- create_vouchers (from 20261103140000)
CREATE OR REPLACE FUNCTION public.create_vouchers(p_event_id uuid, p_items jsonb, p_actor uuid) RETURNS integer
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
      SELECT 1 FROM public.event_partners p WHERE p.id = v_partner AND p.event_id = p_event_id) THEN
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

-- update_voucher (from 20261103140000)
CREATE OR REPLACE FUNCTION public.update_voucher(p_voucher_id uuid, p_fields jsonb, p_actor uuid) RETURNS jsonb
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
      SELECT 1 FROM public.event_partners p WHERE p.id = v.partner_id AND p.event_id = v.event_id) THEN
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

-- set_registration_partner (from 20261103140000)
CREATE OR REPLACE FUNCTION public.set_registration_partner(p_registration_id uuid, p_partner_id uuid, p_actor uuid) RETURNS jsonb
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
    SELECT 1 FROM public.event_partners p WHERE p.id = p_partner_id AND p.event_id = r.event_id) THEN
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

-- apply_transfer (from 20261105090000)
CREATE OR REPLACE FUNCTION public.apply_transfer(p_registration_id uuid, p_person jsonb, p_category_id uuid,
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
    PERFORM 1 FROM public.event_partners WHERE id = r.partner_id FOR KEY SHARE;
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
    -- Changed here: the recipient is an adult, so no minors_only consent.
    SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
      FROM jsonb_array_elements_text(coalesce(p_consent->'consentIds', '[]'::jsonb)) AS t(x);
    SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
      FROM public.event_consents ec WHERE ec.event_id = r.event_id AND NOT ec.minors_only;
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

-- ---------------------------------------------------------------- 6. the old table

DROP TABLE public.registration_partners;

-- ---------------------------------------------------------------- 7. public access

DROP POLICY "Public read" ON public.event_partners;
REVOKE SELECT ON public.event_partners FROM anon, authenticated;
GRANT SELECT (id, event_id, name, logo_url, website_url, sort_order) ON public.event_partners TO anon, authenticated;
CREATE POLICY "Public partners" ON public.event_partners FOR SELECT TO anon, authenticated USING (is_public);

-- ---------------------------------------------------------------- 8. logo bucket

INSERT INTO storage.buckets (id, name, public) VALUES ('partner-logos', 'partner-logos', true)
  ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "Public read access for partner logos" ON storage.objects;
