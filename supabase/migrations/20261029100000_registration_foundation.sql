-- Race registration, foundation (plan 1, task 1).
--
-- * clubs.registration_enabled: online registration is switched on per club.
-- * Six service-role-only tables: registration_waitlist, organizer_agreements,
--   club_payout_details, club_payout_history, registration_settings,
--   organizer_actions. Edge functions own every read and write.
-- * events.club_id, participants.registration_id, participants.removed_at:
--   columns that also exist on the timing hosts (Drizzle side is task 2).
-- * A BEFORE DELETE trigger refuses deletes of a registration event and of its
--   rows (incl. checkin_documents), which covers an old host's syncDeleteEvent
--   (backend/src/sync/supabase.js), which deletes the children before the event.
-- * Removed participants disappear from participants_public and the three PIN
--   RPCs. merge_clubs refuses a club that owns registration data.

-- ---------------------------------------------------------------- clubs

ALTER TABLE public.clubs
  ADD COLUMN registration_enabled boolean NOT NULL DEFAULT false;

-- The one production data change of the plan: the ZATYRANI club (slug verified
-- read-only on 2026-10-28, one row). A no-op on the local stack.
UPDATE public.clubs SET registration_enabled = true WHERE slug = 'zatyrani';

-- ---------------------------------------------------------------- new tables

CREATE TABLE public.registration_waitlist (
  club_id      uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_waitlist_requested_by_idx ON public.registration_waitlist (requested_by);

CREATE TABLE public.organizer_agreements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  club_name   text NOT NULL,
  version     text NOT NULL,
  accepted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_agent  text
);
CREATE INDEX organizer_agreements_club_id_idx ON public.organizer_agreements (club_id);
CREATE INDEX organizer_agreements_accepted_by_idx ON public.organizer_agreements (accepted_by);

CREATE TABLE public.club_payout_details (
  club_id    uuid PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  nip        text NOT NULL,
  krs        text,
  iban       text NOT NULL,
  address    text NOT NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX club_payout_details_updated_by_idx ON public.club_payout_details (updated_by);

CREATE TABLE public.club_payout_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  club_name  text NOT NULL,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  old        jsonb,
  new        jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX club_payout_history_club_id_idx ON public.club_payout_history (club_id);
CREATE INDEX club_payout_history_changed_by_idx ON public.club_payout_history (changed_by);

CREATE TABLE public.registration_settings (
  event_id    uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE RESTRICT,
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  state       text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'closed')),
  timing_mode text NOT NULL DEFAULT 'leszyrun' CHECK (timing_mode IN ('leszyrun', 'external', 'none')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_settings_club_id_idx ON public.registration_settings (club_id);

CREATE TABLE public.organizer_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  club_id    uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
  event_id   uuid,
  action     text NOT NULL,
  target     text,
  payload    jsonb,
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizer_actions_actor_id_idx ON public.organizer_actions (actor_id);
CREATE INDEX organizer_actions_club_id_idx ON public.organizer_actions (club_id);
CREATE INDEX organizer_actions_event_id_idx ON public.organizer_actions (event_id);

-- Service role only. RLS with no policies plus REVOKE, because RLS does not
-- govern TRUNCATE.
ALTER TABLE public.registration_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_agreements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_payout_details   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_payout_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_actions     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_waitlist FROM anon, authenticated;
REVOKE ALL ON public.organizer_agreements  FROM anon, authenticated;
REVOKE ALL ON public.club_payout_details   FROM anon, authenticated;
REVOKE ALL ON public.club_payout_history   FROM anon, authenticated;
REVOKE ALL ON public.registration_settings FROM anon, authenticated;
REVOKE ALL ON public.organizer_actions     FROM anon, authenticated;

-- The owning club of a registration event never changes: every authorization
-- check reads registration_settings.club_id.
CREATE FUNCTION public.refuse_registration_club_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF NEW.club_id IS DISTINCT FROM OLD.club_id THEN
    RAISE EXCEPTION 'registration_settings.club_id cannot be changed (event %)', OLD.event_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.refuse_registration_club_change() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refuse_registration_club_change() TO service_role;

CREATE TRIGGER trg_registration_settings_club_immutable
  BEFORE UPDATE OF club_id ON public.registration_settings
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_club_change();

-- ---------------------------------------------------------------- columns on synced tables

ALTER TABLE public.events
  ADD COLUMN club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL;
CREATE INDEX events_club_id_idx ON public.events (club_id);

ALTER TABLE public.participants
  ADD COLUMN registration_id uuid,
  ADD COLUMN removed_at timestamptz;
CREATE UNIQUE INDEX participants_registration_id_key
  ON public.participants (registration_id) WHERE registration_id IS NOT NULL;

-- ---------------------------------------------------------------- delete refusal

-- Refuses a delete of an event with a registration_settings row, or of one of
-- its rows. The event is found via id (events), category_id -> categories
-- (race_runs), checkin_id -> checkins (checkin_documents) or event_id
-- (everything else). syncDeleteEvent deletes checkin_documents first and
-- ignores errors, so it is guarded too.
-- Deliberately NOT guarded: checkpoint_categories (pushCheckpointLinks replaces
-- a checkpoint's links by delete + insert), results, gate_crossings and
-- checkpoint_observations (resetting race data must keep working).
-- Only bypass-RLS roles delete these tables (none has a
-- DELETE policy), so SECURITY INVOKER reads registration_settings fine.
CREATE FUNCTION public.refuse_registration_event_deletes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_event uuid;
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

  IF v_event IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.registration_settings rs WHERE rs.event_id = v_event) THEN
    RAISE EXCEPTION 'Event % has online registration: deleting its % rows is refused', v_event, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
REVOKE EXECUTE ON FUNCTION public.refuse_registration_event_deletes() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refuse_registration_event_deletes() TO service_role;

CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.participants
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.checkins
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.checkpoints
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.race_runs
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.event_documents
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();
CREATE TRIGGER trg_refuse_registration_event_deletes BEFORE DELETE ON public.checkin_documents
  FOR EACH ROW EXECUTE FUNCTION public.refuse_registration_event_deletes();

-- ---------------------------------------------------------------- removed participants

-- Same columns as before; CREATE OR REPLACE keeps the existing grants (anon SELECT).
CREATE OR REPLACE VIEW public.participants_public AS
 SELECT id,
    bib_number,
    first_name,
    last_name,
    club,
    category_id,
    emoji,
    gender,
    deleted_at
   FROM public.participants
  WHERE removed_at IS NULL;

-- The three PIN-gated RPCs keep their signatures and grants (anon EXECUTE);
-- the only change is "AND p.removed_at IS NULL".
CREATE OR REPLACE FUNCTION public.get_participant_admin(p_event_id uuid, p_pin text, p_participant_id uuid) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  pin_valid BOOLEAN;
  result JSON;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM event_secrets
    WHERE event_id = p_event_id AND checkin_pin = p_pin
  ) INTO pin_valid;

  IF NOT pin_valid THEN
    RAISE EXCEPTION 'Invalid PIN';
  END IF;

  SELECT json_build_object(
    'id', p.id,
    'first_name', p.first_name,
    'last_name', p.last_name,
    'bib_number', p.bib_number,
    'category_id', p.category_id,
    'birth_date', p.birth_date,
    'tshirt_size', p.tshirt_size
  ) INTO result
  FROM participants p
  WHERE p.id = p_participant_id
    AND p.removed_at IS NULL;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_participant_for_checkin(p_participant_id uuid) RETURNS TABLE(id uuid, bib_number integer, first_name text, last_name text, birth_date date, category_id uuid, tshirt_size text, phone text, emoji text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.bib_number,
    p.first_name,
    p.last_name,
    p.birth_date,
    p.category_id,
    p.tshirt_size,
    p.phone,
    p.emoji
  FROM participants p
  WHERE p.id = p_participant_id
    AND p.removed_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_participants_admin(p_event_id uuid, p_pin text, p_query text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
  pin_valid BOOLEAN;
  result JSON;
  cat_ids UUID[];
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM event_secrets
    WHERE event_id = p_event_id AND checkin_pin = p_pin
  ) INTO pin_valid;

  IF NOT pin_valid THEN
    RAISE EXCEPTION 'Invalid PIN';
  END IF;

  SELECT array_agg(id) INTO cat_ids
  FROM categories WHERE event_id = p_event_id;

  IF cat_ids IS NULL THEN
    RETURN '[]'::JSON;
  END IF;

  IF p_query ~ '^\d+$' THEN
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::JSON) INTO result
    FROM (
      SELECT p.id, p.first_name, p.last_name, p.bib_number, p.category_id, p.birth_date, p.tshirt_size
      FROM participants p
      WHERE p.category_id = ANY(cat_ids)
        AND p.removed_at IS NULL
        AND p.bib_number = p_query::INT
    ) t;
  ELSE
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::JSON) INTO result
    FROM (
      SELECT p.id, p.first_name, p.last_name, p.bib_number, p.category_id, p.birth_date, p.tshirt_size
      FROM participants p
      WHERE p.category_id = ANY(cat_ids)
        AND p.removed_at IS NULL
        AND (p.first_name ILIKE '%' || p_query || '%' OR p.last_name ILIKE '%' || p_query || '%')
      LIMIT 20
    ) t;
  END IF;

  RETURN result;
END;
$_$;

-- ---------------------------------------------------------------- merge_clubs

-- Refuses a source club that owns registration events or payout details: the
-- merge deletes the sources, which registration_settings (RESTRICT) would block
-- with an opaque FK error, and club_payout_details (CASCADE) would lose.
-- The message contains "registration"; backend/src/routes/clubs.js maps it to 409.
CREATE OR REPLACE FUNCTION public.merge_clubs(target uuid, sources uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  moved INTEGER;
BEGIN
  IF target = ANY(sources) THEN
    RAISE EXCEPTION 'target cannot be in sources';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = target) THEN
    RAISE EXCEPTION 'target club not found';
  END IF;
  IF (SELECT count(*) FROM clubs WHERE id = ANY(sources)) <> coalesce(array_length(sources, 1), 0)
     OR coalesce(array_length(sources, 1), 0) = 0 THEN
    RAISE EXCEPTION 'unknown or empty source club ids';
  END IF;
  IF EXISTS (SELECT 1 FROM registration_settings WHERE club_id = ANY(sources))
     OR EXISTS (SELECT 1 FROM club_payout_details WHERE club_id = ANY(sources)) THEN
    RAISE EXCEPTION 'source club has online registration events or payout details'
      USING ERRCODE = 'restrict_violation';
  END IF;
  UPDATE profiles SET club_id = target WHERE club_id = ANY(sources);
  GET DIAGNOSTICS moved = ROW_COUNT;
  DELETE FROM clubs WHERE id = ANY(sources);
  RETURN moved;
END $$;

-- Same lines as 20260717053838_remote_schema.sql, plus anon/authenticated:
-- Supabase's default privileges had granted them EXECUTE on this SECURITY
-- DEFINER function, so any holder of the publishable key could merge clubs.
-- The only caller is the backend on the service role.
REVOKE ALL ON FUNCTION public.merge_clubs(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_clubs(uuid, uuid[]) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.merge_clubs(uuid, uuid[]) TO service_role;
