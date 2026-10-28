-- Race registration, plan 2 task 2: the event schema.
--
-- * registration_settings gains the wizard's event fields (all nullable while
--   the event is a draft).
-- * New Supabase-only tables, service role only (RLS on, no policies, REVOKE):
--   office_hours, registration_pending_changes, registration_uploads,
--   competitions, price_tiers, competition_prices, age_groups, kids_groups,
--   event_consents, registrations, consent_acceptances, organizer_messages.
-- * Storage: public bucket registration-files (final files) and private bucket
--   registration-pending (uploads awaiting validation). Neither has a storage
--   policy, so only the service role writes.
-- * claim_competition_slots: the one-statement slot claim (spec 4.8).
-- * participants.registration_id gets its FK to registrations (ON DELETE
--   RESTRICT). Hosts never push that column (PUSH_EXCLUDED_COLUMNS).
-- * refuse_registration_event_deletes lets a category of a DRAFT event through
--   when the transaction set leszyrun.registration_draft_delete = 'on' (the
--   wizard's competition delete RPC).
-- Money is integer grosze throughout.

-- ---------------------------------------------------------------- updated_at

CREATE FUNCTION public.registration_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_touch_updated_at() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_touch_updated_at() TO service_role;

-- ---------------------------------------------------------------- registration_settings

ALTER TABLE public.registration_settings
  ADD COLUMN name                 text,
  ADD COLUMN slug                 text,
  ADD COLUMN event_date           date,
  ADD COLUMN first_start_time     time,
  ADD COLUMN opens_at             timestamptz,
  ADD COLUMN closes_at            timestamptz,
  ADD COLUMN is_charity           boolean NOT NULL DEFAULT false,
  ADD COLUMN charity_goal         text,
  ADD COLUMN donations_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN town_simc            text,
  ADD COLUMN town_label           text,
  ADD COLUMN town_area            text,
  ADD COLUMN place_details        text,
  ADD COLUMN lat                  numeric(9,6),
  ADD COLUMN lng                  numeric(9,6),
  ADD COLUMN office_same_as_event boolean NOT NULL DEFAULT true,
  ADD COLUMN office_address       text,
  ADD COLUMN office_notes         text,
  ADD COLUMN office_lat           numeric(9,6),
  ADD COLUMN office_lng           numeric(9,6),
  ADD COLUMN timing_company       text,
  ADD COLUMN results_url          text,
  ADD COLUMN live_results_url     text,
  ADD COLUMN regulamin_kind       text,
  ADD COLUMN regulamin_url        text,
  ADD COLUMN regulamin_upload_id  uuid,
  ADD COLUMN regulamin_version    integer NOT NULL DEFAULT 0,
  ADD COLUMN poster_upload_id     uuid,
  ADD COLUMN age_reckoning        text NOT NULL DEFAULT 'race_day',
  ADD COLUMN form_fields          jsonb NOT NULL
    DEFAULT '{"phone":"optional","city":"optional","club":"optional","ice":"optional"}'::jsonb,
  ADD COLUMN pricing_mode         text NOT NULL DEFAULT 'free',
  ADD COLUMN published_at         timestamptz,
  ADD CONSTRAINT registration_settings_slug_key UNIQUE (slug),
  -- Same rule as isValidSlug() in _shared/registration (and public/api/event.js).
  ADD CONSTRAINT registration_settings_slug_check
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
  ADD CONSTRAINT registration_settings_window_check CHECK (opens_at < closes_at),
  ADD CONSTRAINT registration_settings_regulamin_kind_check CHECK (regulamin_kind IN ('pdf', 'link')),
  ADD CONSTRAINT registration_settings_regulamin_version_check CHECK (regulamin_version >= 0),
  ADD CONSTRAINT registration_settings_age_reckoning_check CHECK (age_reckoning IN ('race_day', 'year_end')),
  ADD CONSTRAINT registration_settings_form_fields_check CHECK (jsonb_typeof(form_fields) = 'object'),
  ADD CONSTRAINT registration_settings_pricing_mode_check CHECK (pricing_mode IN ('fixed', 'tiered', 'free')),
  ADD CONSTRAINT registration_settings_lat_check CHECK (lat BETWEEN -90 AND 90),
  ADD CONSTRAINT registration_settings_lng_check CHECK (lng BETWEEN -180 AND 180),
  ADD CONSTRAINT registration_settings_office_lat_check CHECK (office_lat BETWEEN -90 AND 90),
  ADD CONSTRAINT registration_settings_office_lng_check CHECK (office_lng BETWEEN -180 AND 180);

CREATE TRIGGER trg_registration_settings_updated_at
  BEFORE UPDATE ON public.registration_settings
  FOR EACH ROW EXECUTE FUNCTION public.registration_touch_updated_at();

-- ---------------------------------------------------------------- uploads, office, pending changes

CREATE TABLE public.registration_uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('poster', 'regulamin', 'gpx')),
  path        text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_uploads_event_id_idx ON public.registration_uploads (event_id);
CREATE INDEX registration_uploads_uploaded_by_idx ON public.registration_uploads (uploaded_by);

ALTER TABLE public.registration_settings
  ADD CONSTRAINT registration_settings_regulamin_upload_id_fkey
    FOREIGN KEY (regulamin_upload_id) REFERENCES public.registration_uploads(id) ON DELETE SET NULL,
  ADD CONSTRAINT registration_settings_poster_upload_id_fkey
    FOREIGN KEY (poster_upload_id) REFERENCES public.registration_uploads(id) ON DELETE SET NULL;
CREATE INDEX registration_settings_regulamin_upload_id_idx ON public.registration_settings (regulamin_upload_id);
CREATE INDEX registration_settings_poster_upload_id_idx ON public.registration_settings (poster_upload_id);

CREATE TABLE public.office_hours (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  CHECK (starts_at < ends_at)
);
CREATE INDEX office_hours_event_id_idx ON public.office_hours (event_id);

CREATE TABLE public.registration_pending_changes (
  event_id       uuid PRIMARY KEY REFERENCES public.registration_settings(event_id) ON DELETE CASCADE,
  payload        jsonb NOT NULL,
  changed_fields text[] NOT NULL,
  updated_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_pending_changes_updated_by_idx ON public.registration_pending_changes (updated_by);
CREATE TRIGGER trg_registration_pending_changes_updated_at
  BEFORE UPDATE ON public.registration_pending_changes
  FOR EACH ROW EXECUTE FUNCTION public.registration_touch_updated_at();

-- ---------------------------------------------------------------- competitions and prices

-- A competition is a categories row (what timing races) plus its registration
-- fields. category_id RESTRICT: a category is deleted only after its
-- competition, inside the draft-delete RPC.
CREATE TABLE public.competitions (
  category_id       uuid PRIMARY KEY REFERENCES public.categories(id) ON DELETE RESTRICT,
  event_id          uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE CASCADE,
  name              text NOT NULL,
  kind              text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual', 'team')),
  team_min          integer CHECK (team_min >= 1),
  team_max          integer CHECK (team_max >= 1),
  discipline        text CHECK (discipline IN ('run', 'nw')),
  distance_label    text,
  start_time        time,
  capacity          integer NOT NULL CHECK (capacity >= 1),
  -- taken may exceed capacity (a transfer into a full competition, spec 4.8);
  -- new claims check taken + n <= capacity in claim_competition_slots.
  taken             integer NOT NULL DEFAULT 0 CHECK (taken >= 0),
  min_age           integer CHECK (min_age >= 0),
  max_age           integer CHECK (max_age >= 0),
  is_kids           boolean NOT NULL DEFAULT false,
  kids_distance_mode text,
  timed             boolean NOT NULL DEFAULT true,
  gpx_upload_id     uuid REFERENCES public.registration_uploads(id) ON DELETE SET NULL,
  leg_order_enabled boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL,
  -- After publish a competition is hidden, never deleted.
  hidden_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (team_min <= team_max),
  CHECK (min_age <= max_age)
);
CREATE INDEX competitions_event_id_idx ON public.competitions (event_id);
CREATE INDEX competitions_gpx_upload_id_idx ON public.competitions (gpx_upload_id);
CREATE TRIGGER trg_competitions_updated_at
  BEFORE UPDATE ON public.competitions
  FOR EACH ROW EXECUTE FUNCTION public.registration_touch_updated_at();

-- Fixed pricing = exactly one tier with ends_on null (null = until registration closes).
CREATE TABLE public.price_tiers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE CASCADE,
  ends_on    date,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX price_tiers_event_id_idx ON public.price_tiers (event_id);

CREATE TABLE public.competition_prices (
  category_id uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE CASCADE,
  tier_id     uuid NOT NULL REFERENCES public.price_tiers(id) ON DELETE CASCADE,
  amount      integer NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (category_id, tier_id)
);
CREATE INDEX competition_prices_tier_id_idx ON public.competition_prices (tier_id);

-- Open K/M are implicit (no rows).
CREATE TABLE public.age_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE CASCADE,
  gender      text NOT NULL CHECK (gender IN ('M', 'K')),
  label       text NOT NULL,
  min_age     integer NOT NULL CHECK (min_age >= 0),
  max_age     integer,
  CHECK (max_age >= min_age)
);
CREATE INDEX age_groups_category_id_idx ON public.age_groups (category_id);

CREATE TABLE public.kids_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE CASCADE,
  label           text NOT NULL,
  birth_year_from integer NOT NULL,
  birth_year_to   integer NOT NULL,
  gender          text CHECK (gender IN ('M', 'K')),
  distance_label  text,
  CHECK (birth_year_from <= birth_year_to)
);
CREATE INDEX kids_groups_category_id_idx ON public.kids_groups (category_id);

-- ---------------------------------------------------------------- consents

-- regulamin + data_info are created with the event and never deleted; all are required.
CREATE TABLE public.event_consents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('regulamin', 'data_info', 'custom')),
  text       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_consents_event_id_idx ON public.event_consents (event_id);
CREATE TRIGGER trg_event_consents_updated_at
  BEFORE UPDATE ON public.event_consents
  FOR EACH ROW EXECUTE FUNCTION public.registration_touch_updated_at();

-- ---------------------------------------------------------------- registrations

-- One person in one competition. order_id, team_id, voucher_id, partner_id and
-- kids_group_id are plain uuids: their tables (or FKs) come in later plans.
CREATE TABLE public.registrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  category_id         uuid NOT NULL REFERENCES public.competitions(category_id) ON DELETE RESTRICT,
  team_id             uuid,
  team_leg            integer CHECK (team_leg >= 1),
  order_id            uuid,
  status              text NOT NULL
    CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'expired', 'transferred_out')),
  profile_id          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  birth_date          date,
  gender              text CHECK (gender IN ('M', 'K')),
  email               text,
  phone               text,
  city                text,
  club                text,
  ice_name            text,
  ice_phone           text,
  guardian_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  guardian_name       text,
  guardian_email      text,
  age_group_label     text,
  kids_group_id       uuid,
  consent_state       text NOT NULL CHECK (consent_state IN ('accepted', 'awaiting', 'office')),
  voucher_id          uuid,
  partner_id          uuid,
  list_price          integer NOT NULL DEFAULT 0 CHECK (list_price >= 0),
  price               integer NOT NULL DEFAULT 0 CHECK (price >= 0),
  refunded            integer NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  participant_id      uuid REFERENCES public.participants(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded <= price)
);
-- One person, one start: one live registration per event and email.
CREATE UNIQUE INDEX registrations_event_email_live_key
  ON public.registrations (event_id, lower(email))
  WHERE status IN ('pending_payment', 'confirmed') AND email IS NOT NULL;
CREATE INDEX registrations_event_id_idx ON public.registrations (event_id);
CREATE INDEX registrations_category_id_idx ON public.registrations (category_id);
CREATE INDEX registrations_profile_id_idx ON public.registrations (profile_id);
CREATE INDEX registrations_guardian_profile_id_idx ON public.registrations (guardian_profile_id);
CREATE INDEX registrations_participant_id_idx ON public.registrations (participant_id);
CREATE INDEX registrations_order_id_idx ON public.registrations (order_id);
CREATE TRIGGER trg_registrations_updated_at
  BEFORE UPDATE ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.registration_touch_updated_at();

-- Spec 14.5: the bridge FK. Hosts never push this column, so they are unaffected.
ALTER TABLE public.participants
  ADD CONSTRAINT participants_registration_id_fkey
    FOREIGN KEY (registration_id) REFERENCES public.registrations(id) ON DELETE RESTRICT;

-- Append-only. consent_id is null only for the LESZY.RUN service regulamin.
CREATE TABLE public.consent_acceptances (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id        uuid NOT NULL REFERENCES public.registrations(id) ON DELETE RESTRICT,
  consent_id             uuid REFERENCES public.event_consents(id) ON DELETE RESTRICT,
  consent_kind           text NOT NULL
    CHECK (consent_kind IN ('regulamin', 'data_info', 'custom', 'service_regulamin')),
  accepted_by_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_as            text NOT NULL CHECK (accepted_as IN ('self', 'guardian', 'office')),
  regulamin_version      integer,
  accepted_at            timestamptz NOT NULL DEFAULT now(),
  ip                     inet,
  user_agent             text,
  CHECK ((consent_id IS NULL) = (consent_kind = 'service_regulamin'))
);
CREATE INDEX consent_acceptances_registration_id_idx ON public.consent_acceptances (registration_id);
CREATE INDEX consent_acceptances_consent_id_idx ON public.consent_acceptances (consent_id);
CREATE INDEX consent_acceptances_accepted_by_profile_id_idx ON public.consent_acceptances (accepted_by_profile_id);

-- ---------------------------------------------------------------- messaging

CREATE TABLE public.organizer_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  sent_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  filter          jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  sent_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizer_messages_event_id_idx ON public.organizer_messages (event_id);
CREATE INDEX organizer_messages_sent_by_idx ON public.organizer_messages (sent_by);

-- ---------------------------------------------------------------- lockdown

-- Service role only. RLS with no policies plus REVOKE, because RLS does not
-- govern TRUNCATE.
ALTER TABLE public.registration_uploads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_hours                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_pending_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitions                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_tiers                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competition_prices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.age_groups                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kids_groups                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_consents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consent_acceptances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_messages           ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_uploads         FROM anon, authenticated;
REVOKE ALL ON public.office_hours                 FROM anon, authenticated;
REVOKE ALL ON public.registration_pending_changes FROM anon, authenticated;
REVOKE ALL ON public.competitions                 FROM anon, authenticated;
REVOKE ALL ON public.price_tiers                  FROM anon, authenticated;
REVOKE ALL ON public.competition_prices           FROM anon, authenticated;
REVOKE ALL ON public.age_groups                   FROM anon, authenticated;
REVOKE ALL ON public.kids_groups                  FROM anon, authenticated;
REVOKE ALL ON public.event_consents               FROM anon, authenticated;
REVOKE ALL ON public.registrations                FROM anon, authenticated;
REVOKE ALL ON public.consent_acceptances          FROM anon, authenticated;
REVOKE ALL ON public.organizer_messages           FROM anon, authenticated;

-- ---------------------------------------------------------------- storage

-- Final files (poster, regulamin PDF, GPX): public read. Pending uploads wait
-- in the private bucket until the edge function validated them. No
-- storage.objects policy for either, so only the service role writes.
INSERT INTO storage.buckets (id, name, public)
VALUES ('registration-files', 'registration-files', true),
       ('registration-pending', 'registration-pending', false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------- slot claim

-- Spec 4.8: the write IS the check. Returns the new taken, or null when the
-- competition has no room for p_n more. Called inside the registration RPCs
-- (SECURITY DEFINER themselves), so this one runs as its caller.
CREATE FUNCTION public.claim_competition_slots(p_category_id uuid, p_n integer) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_taken integer;
BEGIN
  IF p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'claim_competition_slots: n must be >= 1 (got %)', p_n
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.competitions
     SET taken = taken + p_n
   WHERE category_id = p_category_id
     AND taken + p_n <= capacity
  RETURNING taken INTO v_taken;
  RETURN v_taken;
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_competition_slots(uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_competition_slots(uuid, integer) TO service_role;

-- ---------------------------------------------------------------- delete refusal

-- Same as 20261029100000, plus one exception: a categories row of a DRAFT
-- registration event may be deleted when the transaction set
-- leszyrun.registration_draft_delete = 'on' (set_config(..., true), so it ends
-- with the transaction). Only the wizard's competition delete RPC sets it, and
-- competitions.category_id RESTRICT still requires the competition to go first.
-- Every other table, and every published or closed event, stays refused.
CREATE OR REPLACE FUNCTION public.refuse_registration_event_deletes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_event uuid;
  v_state text;
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    v_event := OLD.id;
  ELSIF TG_TABLE_NAME = 'race_runs' THEN
    SELECT c.event_id INTO v_event FROM public.categories c WHERE c.id = OLD.category_id;
  ELSIF TG_TABLE_NAME = 'checkin_documents' THEN
    SELECT ck.event_id INTO v_event FROM public.checkins ck WHERE ck.id = OLD.checkin_id;
  ELSE
    v_event := OLD.event_id;
  END IF;

  IF v_event IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT rs.state INTO v_state FROM public.registration_settings rs WHERE rs.event_id = v_event;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'categories'
     AND v_state = 'draft'
     AND current_setting('leszyrun.registration_draft_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Event % has online registration: deleting its % rows is refused', v_event, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
