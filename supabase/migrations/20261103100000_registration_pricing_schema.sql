-- Plan 7, task 2: the tables of vouchers, partners, extras and transfers, and the SQL mirrors of
-- the pricing rules in _shared/registration/pricing.js.
--
-- Every new table is service-role only: RLS on and REVOKE ALL from anon and authenticated. Every
-- read and write goes through an edge function or an RPC.
--
-- Money rules this file states in the database:
--   * a voucher's use is counted in `used`, never above `max_uses` (at most MAX_VOUCHER_USES,
--     100 000, in vouchers.js); a variant's `sold` never above its `stock` (at most 100 000);
--   * a list or extra price is at most MAX_LIST_PRICE, 10 000 000 grosze (pricing.js);
--   * nothing is payable to LESZY.RUN and a transfer costs 0 (ruling 1): `transfer_fee` and
--     `transfers.fee` are checked = 0.
--
-- A voucher, a partner and a registration belong to one event. The foreign keys from registrations
-- and vouchers carry event_id, so a registration can never hold another event's voucher or partner
-- (a partner of another club would otherwise show in this organizer's B3).
--
-- registration_current_tier gains p_now (V-12 compares it with currentTier at fixed instants). Its
-- one-argument version is dropped, not overloaded: with p_now defaulted, the two would make every
-- one-argument call ambiguous. The OUT columns (o_id, o_ends_on, o_label) stay, because
-- create_order and create_team_registration (20261101110000) read all three for the tier snapshot
-- on an entry line, and they resolve the call at run time, so they keep working unchanged.

-- ---------------------------------------------------------------- lock order

-- Live sign-ups take registration_settings FOR SHARE and then write registrations (D3-1). This file
-- takes registration_settings first, in its strongest mode (the ADD COLUMN, ACCESS EXCLUSIVE), so
-- it never holds a lock on registrations while waiting for the settings: a sign-up in flight
-- either finishes first or waits behind the whole migration. The timeout makes a release that
-- still cannot get its locks fail fast and leave sign-ups alone, rather than queue them.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------- transfer settings

-- „Przekazanie pakietu” in Płatności, saved through the payments section (D7-22). The fee is not
-- rendered and stays 0 until the user decides otherwise (ruling 1).
ALTER TABLE public.registration_settings
  ADD COLUMN transfer_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN transfer_until   date,
  ADD COLUMN transfer_fee     integer NOT NULL DEFAULT 0 CONSTRAINT registration_settings_transfer_fee_check CHECK (transfer_fee = 0);

-- ---------------------------------------------------------------- list price cap

-- MAX_LIST_PRICE (pricing.js) = MAX_PRICE_GROSZE (sections.js), which has refused a higher price
-- since competition_prices was created (Plan 2, #323), so no stored row can exceed it. Above it
-- registration_discounted_price raises; with this check no stored price can reach that branch.
ALTER TABLE public.competition_prices
  ADD CONSTRAINT competition_prices_amount_max CHECK (amount <= 10000000);

-- ---------------------------------------------------------------- partners

CREATE TABLE public.registration_partners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  note       text CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id)
);
CREATE UNIQUE INDEX registration_partners_event_name_key ON public.registration_partners (event_id, lower(name));
CREATE INDEX registration_partners_event_id_idx ON public.registration_partners (event_id);

ALTER TABLE public.registration_partners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_partners FROM anon, authenticated;

-- ---------------------------------------------------------------- vouchers

-- `code` is stored as normalizeCode (vouchers.js) leaves it: ASCII letters, digits and '-', upper
-- case, 4–32 characters, at least one letter or digit. The check refuses anything else, so a lower
-- case or folded code can never sit beside its upper-case twin, and (event_id, code) is the
-- case-insensitive uniqueness §16 asks for.
CREATE TABLE public.vouchers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9-]{4,32}$' AND code ~ '[A-Z0-9]'),
  percent     integer NOT NULL CHECK (percent BETWEEN 1 AND 100),
  max_uses    integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100000),
  used        integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  valid_until timestamptz,
  partner_id  uuid,
  note        text CHECK (char_length(note) <= 500),
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT vouchers_used_within_max CHECK (used <= max_uses),
  CONSTRAINT vouchers_event_code_key UNIQUE (event_id, code),
  UNIQUE (id, event_id),
  CONSTRAINT vouchers_partner_id_fkey FOREIGN KEY (partner_id, event_id)
    REFERENCES public.registration_partners (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX vouchers_event_id_idx ON public.vouchers (event_id);
CREATE INDEX vouchers_partner_id_idx ON public.vouchers (partner_id);
CREATE INDEX vouchers_created_by_idx ON public.vouchers (created_by);

-- No rows = every competition. A link goes with its voucher (a voucher is deleted only while
-- nothing references it, ruling 11), and a competition with links cannot be deleted: dropping the
-- last link would silently widen a restricted code to every competition.
CREATE TABLE public.voucher_competitions (
  voucher_id  uuid NOT NULL REFERENCES public.vouchers(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE RESTRICT,
  PRIMARY KEY (voucher_id, category_id)
);
CREATE INDEX voucher_competitions_category_id_idx ON public.voucher_competitions (category_id);

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vouchers FROM anon, authenticated;
ALTER TABLE public.voucher_competitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_competitions FROM anon, authenticated;

-- ---------------------------------------------------------------- extras

-- An extra's image is a one-step upload like the poster (upload-registration-file, kind 'extra').
ALTER TABLE public.registration_uploads DROP CONSTRAINT registration_uploads_kind_check;
ALTER TABLE public.registration_uploads
  ADD CONSTRAINT registration_uploads_kind_check CHECK (kind IN ('poster', 'regulamin', 'gpx', 'extra')),
  ADD CONSTRAINT registration_uploads_id_event_kind_key UNIQUE (id, event_id, kind);

-- image_kind is the constant half of the image's foreign key: the image must be this event's own
-- upload of kind 'extra', never another event's file or a regulamin. A deleted upload nulls only
-- image_upload_id.
CREATE TABLE public.extras (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  image_upload_id uuid,
  image_kind      text NOT NULL DEFAULT 'extra' CHECK (image_kind = 'extra'),
  price           integer NOT NULL CHECK (price BETWEEN 0 AND 10000000),
  order_until     date NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  CONSTRAINT extras_image_upload_id_fkey FOREIGN KEY (image_upload_id, event_id, image_kind)
    REFERENCES public.registration_uploads (id, event_id, kind) ON DELETE SET NULL (image_upload_id)
);
CREATE INDEX extras_event_id_idx ON public.extras (event_id);
CREATE INDEX extras_image_upload_id_idx ON public.extras (image_upload_id);

-- Unlimited stock is 100 000 written by the UI („Bez limitu”), never null (§4.8).
CREATE TABLE public.extra_variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extra_id   uuid NOT NULL REFERENCES public.extras(id) ON DELETE RESTRICT,
  label      text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60 AND label = btrim(label)),
  stock      integer NOT NULL CHECK (stock BETWEEN 0 AND 100000),
  sold       integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT extra_variants_sold_within_stock CHECK (sold >= 0 AND sold <= stock)
);
CREATE INDEX extra_variants_extra_id_idx ON public.extra_variants (extra_id);

-- No rows = every competition; the same rules as voucher_competitions.
CREATE TABLE public.extra_competitions (
  extra_id    uuid NOT NULL REFERENCES public.extras(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE RESTRICT,
  PRIMARY KEY (extra_id, category_id)
);
CREATE INDEX extra_competitions_category_id_idx ON public.extra_competitions (category_id);

ALTER TABLE public.extras ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extras FROM anon, authenticated;
ALTER TABLE public.extra_variants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extra_variants FROM anon, authenticated;
ALTER TABLE public.extra_competitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.extra_competitions FROM anon, authenticated;

-- Plan 3 left this a plain uuid until the extras existed. An extra line names a variant and only an
-- extra line does (no extra line exists before this file). order_lines has no event_id, so the
-- variant's event is checked against the order's by a trigger, with the foreign key's error code.
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_extra_variant_id_fkey
    FOREIGN KEY (extra_variant_id) REFERENCES public.extra_variants(id) ON DELETE RESTRICT,
  ADD CONSTRAINT order_lines_extra_variant_check CHECK ((kind = 'extra') = (extra_variant_id IS NOT NULL));

CREATE FUNCTION public.order_lines_extra_same_event() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
      JOIN public.extra_variants v ON v.id = NEW.extra_variant_id
      JOIN public.extras e ON e.id = v.extra_id
     WHERE o.id = NEW.order_id AND e.event_id = o.event_id
  ) THEN
    RAISE EXCEPTION 'order_lines_extra_variant_event' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.order_lines_extra_same_event() FROM public, anon, authenticated, service_role;

CREATE TRIGGER order_lines_extra_same_event
  BEFORE INSERT OR UPDATE OF order_id, extra_variant_id ON public.order_lines
  FOR EACH ROW
  WHEN (NEW.extra_variant_id IS NOT NULL)
  EXECUTE FUNCTION public.order_lines_extra_same_event();

-- ---------------------------------------------------------------- registrations: voucher and partner

-- Plan 2 left both plain uuids. A used voucher or a partner somebody carries cannot be deleted
-- (ruling 11: „Wyłącz” instead). Indexed by the referencing column, the one the delete looks up.
ALTER TABLE public.registrations
  ADD CONSTRAINT registrations_voucher_id_fkey FOREIGN KEY (voucher_id, event_id)
    REFERENCES public.vouchers (id, event_id) ON DELETE RESTRICT,
  ADD CONSTRAINT registrations_partner_id_fkey FOREIGN KEY (partner_id, event_id)
    REFERENCES public.registration_partners (id, event_id) ON DELETE RESTRICT;
CREATE INDEX registrations_voucher_id_idx ON public.registrations (voucher_id);
CREATE INDEX registrations_partner_id_idx ON public.registrations (partner_id);

-- ---------------------------------------------------------------- transfers

-- One package handed from a registration to a new one (§4.5, rulings 1–5).
--   kind 'runner': the holder invites by e-mail; the link carries a token whose SHA-256 is
--     token_hash, valid until expires_at (Warsaw day after transfer_until, ruling 4).
--   kind 'organizer': B3 types the recipient in; no token and no link expiry.
-- Both registrations belong to the transfer's event (composite keys on registrations (id, event_id)).
-- At most one pending transfer per registration. to_email is stored lower case; delete-my-account
-- nulls it on an invite it cancels, so it may be null once the transfer is not pending.
-- The accept path (Plan 7 task 6) repoints teams.captain_registration_id to the new registration
-- before the old one leaves live: teams_follow_captain releases a team only through its current
-- captain, so the team stays.
ALTER TABLE public.registrations ADD CONSTRAINT registrations_id_event_id_key UNIQUE (id, event_id);

CREATE TABLE public.transfers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id               uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  registration_id        uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('runner', 'organizer')),
  from_profile_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  to_email               text CHECK (to_email = lower(btrim(to_email)) AND char_length(to_email) <= 254
                                     AND to_email LIKE '%_@_%'),
  token_hash             text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
  fee                    integer NOT NULL DEFAULT 0 CHECK (fee = 0),
  new_registration_id    uuid,
  expires_at             timestamptz,
  accepted_at            timestamptz,
  accepted_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_token_by_kind CHECK ((kind = 'runner') = (token_hash IS NOT NULL)),
  CONSTRAINT transfers_runner_expires CHECK (kind = 'organizer' OR expires_at IS NOT NULL),
  CONSTRAINT transfers_pending_has_address CHECK (status <> 'pending' OR to_email IS NOT NULL),
  CONSTRAINT transfers_accepted_complete CHECK (status <> 'accepted' OR (accepted_at IS NOT NULL AND new_registration_id IS NOT NULL)),
  CONSTRAINT transfers_cancelled_at CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CONSTRAINT transfers_not_to_itself CHECK (new_registration_id <> registration_id),
  CONSTRAINT transfers_registration_id_fkey FOREIGN KEY (registration_id, event_id)
    REFERENCES public.registrations (id, event_id) ON DELETE RESTRICT,
  CONSTRAINT transfers_new_registration_id_fkey FOREIGN KEY (new_registration_id, event_id)
    REFERENCES public.registrations (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX transfers_event_id_idx ON public.transfers (event_id);
CREATE UNIQUE INDEX transfers_registration_pending_key ON public.transfers (registration_id) WHERE status = 'pending';
CREATE UNIQUE INDEX transfers_new_registration_id_key ON public.transfers (new_registration_id) WHERE new_registration_id IS NOT NULL;
CREATE INDEX transfers_registration_id_idx ON public.transfers (registration_id);
CREATE INDEX transfers_from_profile_id_idx ON public.transfers (from_profile_id);
CREATE INDEX transfers_accepted_by_profile_id_idx ON public.transfers (accepted_by_profile_id);
-- Every status, not only pending: export-my-data reads all transfers addressed to a person, and
-- delete-my-account (forget_transfer_parties) clears to_email on the non-pending ones.
CREATE INDEX transfers_to_email_idx ON public.transfers (to_email);

ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transfers FROM anon, authenticated;

-- ---------------------------------------------------------------- SQL mirrors of pricing.js

-- discountedPrice: list − floor(list × percent / 100). Both operands are non-negative, so integer
-- division is floor. A null percent is no voucher. Out-of-range input raises, as the JS throws.
CREATE FUNCTION public.registration_discounted_price(p_list integer, p_percent integer) RETURNS integer
  LANGUAGE plpgsql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = ''
AS $$
BEGIN
  IF p_list IS NULL OR p_list < 0 OR p_list > 10000000 THEN
    RAISE EXCEPTION 'invalid_amount:list' USING ERRCODE = '22023';
  END IF;
  IF p_percent IS NULL THEN
    RETURN p_list;
  END IF;
  IF p_percent < 1 OR p_percent > 100 THEN
    RAISE EXCEPTION 'invalid_percent' USING ERRCODE = '22023';
  END IF;
  RETURN (p_list::bigint - (p_list::bigint * p_percent) / 100)::integer;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_discounted_price(integer, integer) FROM public, anon, authenticated, service_role;

-- currentTier: the first tier with ends_on null or ends_on >= the Warsaw day of p_now, in
-- registration_raw's order. A tier ending D is current through 23:59:59.999 Warsaw on D.
DROP FUNCTION public.registration_current_tier(uuid);
CREATE FUNCTION public.registration_current_tier(p_event_id uuid, p_now timestamptz DEFAULT now(),
                                                 OUT o_id uuid, OUT o_ends_on date, OUT o_label text)
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT t.id, t.ends_on,
         CASE WHEN t.ends_on IS NULL THEN 'do zamknięcia zapisów'
              ELSE 'do ' || to_char(t.ends_on, 'DD.MM.YYYY') END
    FROM public.price_tiers t
   WHERE t.event_id = p_event_id
     AND (t.ends_on IS NULL OR t.ends_on >= (p_now AT TIME ZONE 'Europe/Warsaw')::date)
   ORDER BY t.ends_on NULLS LAST, t.sort_order, t.id
   LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.registration_current_tier(uuid, timestamptz) FROM public, anon, authenticated, service_role;

-- A competition's list price in one tier; null when the tier has no price for it.
CREATE FUNCTION public.registration_tier_price(p_category_id uuid, p_tier_id uuid) RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT p.amount FROM public.competition_prices p
   WHERE p.category_id = p_category_id AND p.tier_id = p_tier_id
$$;
REVOKE EXECUTE ON FUNCTION public.registration_tier_price(uuid, uuid) FROM public, anon, authenticated, service_role;

-- Plan 5's helper (20261101110000), now on the two above. Same signature, so its grants stay.
CREATE OR REPLACE FUNCTION public.registration_current_price(p_category_id uuid) RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT public.registration_tier_price(c.category_id,
           (SELECT t.o_id FROM public.registration_current_tier(c.event_id) t))
    FROM public.competitions c
   WHERE c.category_id = p_category_id
$$;
