-- Close what the publishable (anon) key could do directly through PostgREST.
-- Security review 2026-10-25. Every write below that the app still needs now
-- goes through an edge function on the service role:
--   self-checkin     — the runner's own check-in (was: anon INSERT on checkins
--                      + get_participant_for_checkin)
--   checkpoint-write — volunteer entries and Pi agent observations/heartbeats
--                      (was: anon INSERT on checkpoint_observations, anon
--                      INSERT/UPDATE on checkpoint_agents)

-- ---------------------------------------------------------------------------
-- 1. Participant PII
-- ---------------------------------------------------------------------------

-- Returned phone + birth date for ANY participant id, no PIN, to anon. The ids
-- are public (participants_public, results), so this was the whole register.
DROP FUNCTION IF EXISTS public.get_participant_for_checkin(uuid);

-- Check-in links carry HMAC(checkin_link_key, participant_id), so a participant
-- id alone no longer checks anybody in. One key per event; event_secrets is
-- service-role only. The default is volatile, so existing rows get distinct keys.
ALTER TABLE public.event_secrets
  ADD COLUMN IF NOT EXISTS checkin_link_key text NOT NULL
  DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

DROP POLICY IF EXISTS "Anon insert once" ON public.checkins;
DROP POLICY IF EXISTS "Anon insert" ON public.checkin_documents;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.checkins, public.checkin_documents FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Check-in PIN: lockout after repeated failures
-- ---------------------------------------------------------------------------

-- 6 digits and no limit at all: about 900k guesses through /rest/v1/rpc.
-- 30 failures per event per 15 minutes locks the PIN for everyone, attacker
-- included. The advisory lock serialises attempts for one event, so parallel
-- requests cannot all read the same failure count. A failure is only RECORDED
-- if the transaction commits, so no caller below may RAISE on a wrong PIN.
CREATE OR REPLACE FUNCTION public.checkin_pin_ok(p_event_id uuid, p_pin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_failures integer;
  v_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_pin:' || p_event_id::text, 0));

  SELECT count(*) INTO v_failures
    FROM pin_attempts
   WHERE event_id = p_event_id
     AND NOT success
     AND attempted_at > now() - interval '15 minutes';
  IF v_failures >= 30 THEN
    RAISE EXCEPTION 'Too many attempts';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM event_secrets
     WHERE event_id = p_event_id
       AND checkin_pin IS NOT NULL
       AND checkin_pin = p_pin
  ) INTO v_ok;

  IF NOT v_ok THEN
    INSERT INTO pin_attempts (event_id, success) VALUES (p_event_id, false);
  END IF;
  RETURN v_ok;
END;
$$;
REVOKE ALL ON FUNCTION public.checkin_pin_ok(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_checkin_pin(p_event_id uuid, p_pin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN checkin_pin_ok(p_event_id, p_pin);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_checkin_pin(p_event_id uuid, p_pin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN checkin_pin_ok(p_event_id, p_pin);
END;
$$;

-- Wrong PIN now returns NULL instead of raising, so the failure is recorded.
CREATE OR REPLACE FUNCTION public.get_participant_admin(p_event_id uuid, p_pin text, p_participant_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result json;
BEGIN
  IF NOT checkin_pin_ok(p_event_id, p_pin) THEN
    RETURN NULL;
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
    AND p.event_id = p_event_id;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_participants_admin(p_event_id uuid, p_pin text, p_query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result json;
  cat_ids uuid[];
BEGIN
  IF NOT checkin_pin_ok(p_event_id, p_pin) THEN
    RETURN '[]'::json;
  END IF;

  SELECT array_agg(id) INTO cat_ids FROM categories WHERE event_id = p_event_id;
  IF cat_ids IS NULL THEN
    RETURN '[]'::json;
  END IF;

  IF p_query ~ '^\d+$' THEN
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO result
    FROM (
      SELECT p.id, p.first_name, p.last_name, p.bib_number, p.category_id, p.birth_date, p.tshirt_size
      FROM participants p
      WHERE p.category_id = ANY(cat_ids)
        AND p.bib_number = p_query::int
    ) t;
  ELSE
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) INTO result
    FROM (
      SELECT p.id, p.first_name, p.last_name, p.bib_number, p.category_id, p.birth_date, p.tshirt_size
      FROM participants p
      WHERE p.category_id = ANY(cat_ids)
        AND (p.first_name ILIKE '%' || p_query || '%' OR p.last_name ILIKE '%' || p_query || '%')
      LIMIT 20
    ) t;
  END IF;

  RETURN result;
END;
$$;

-- The overload the admin page calls. Same behaviour as before, plus the
-- lockout. It already answered a wrong PIN with an error object, not a RAISE.
CREATE OR REPLACE FUNCTION public.checkin_confirm(p_participant_id uuid, p_pin text, p_documents jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id uuid;
  v_checkin_id uuid;
  v_doc jsonb;
BEGIN
  SELECT event_id INTO v_event_id FROM participants WHERE id = p_participant_id;
  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Participant not found');
  END IF;

  IF NOT checkin_pin_ok(v_event_id, p_pin) THEN
    RETURN jsonb_build_object('error', 'Invalid PIN');
  END IF;

  INSERT INTO checkins (participant_id, event_id, checked_in_at)
  VALUES (p_participant_id, v_event_id, now())
  ON CONFLICT (participant_id) DO UPDATE SET checked_in_at = now(), updated_at = now()
  RETURNING id INTO v_checkin_id;

  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO checkin_documents (checkin_id, document_id, completed_at, completed_by)
    VALUES (
      v_checkin_id,
      (v_doc->>'document_id')::uuid,
      now(),
      COALESCE(v_doc->>'completed_by', 'admin')
    )
    ON CONFLICT (checkin_id, document_id) DO UPDATE SET
      completed_at = now(),
      completed_by = COALESCE(EXCLUDED.completed_by, checkin_documents.completed_by);
  END LOOP;

  RETURN jsonb_build_object('success', true, 'checkin_id', v_checkin_id);
END;
$$;

-- Unused overload. It never checked that the participant belonged to
-- p_event_id, so one event's PIN checked in runners of any other event.
DROP FUNCTION IF EXISTS public.checkin_confirm(uuid, uuid, text, jsonb);

REVOKE ALL ON public.pin_attempts FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Tables that had RLS off and GRANT ALL to anon (full CRUD via PostgREST)
-- ---------------------------------------------------------------------------

ALTER TABLE public.event_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badge_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkpoint_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dismissed_duplicates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.event_partners, public.badge_definitions, public.gate_events,
  public.checkpoint_readings, public.checkpoint_imports, public.dismissed_duplicates
  FROM anon, authenticated;

-- Read by the public app: partner logos on event pages, badges on profiles.
GRANT SELECT ON public.event_partners, public.badge_definitions TO anon, authenticated;
CREATE POLICY "Public read" ON public.event_partners FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read" ON public.badge_definitions FOR SELECT TO anon, authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 4. Checkpoint writes: only through checkpoint-write (checks checkpoint_pin)
-- ---------------------------------------------------------------------------

-- Anyone could pre-fill every bib at every checkpoint. The first row wins
-- UNIQUE(checkpoint_id, bib_number), so the real passes were then dropped.
DROP POLICY IF EXISTS "anon insert observations" ON public.checkpoint_observations;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.checkpoint_observations FROM anon, authenticated;

DROP POLICY IF EXISTS "anon insert checkpoint_agents" ON public.checkpoint_agents;
DROP POLICY IF EXISTS "anon update checkpoint_agents" ON public.checkpoint_agents;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.checkpoint_agents FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Direct INSERTs that bypassed the edge functions' auth and throttles
-- ---------------------------------------------------------------------------

-- Any user_id could be written, and the forged rows then showed up in that
-- person's moderation history and data export. submit-contribution is the writer.
DROP POLICY IF EXISTS "Anyone can submit pending events" ON public.calendar_events;
DROP POLICY IF EXISTS "Anyone can create reports" ON public.calendar_event_reports;
DROP POLICY IF EXISTS "anon_insert_feedback" ON public.website_feedback;
REVOKE INSERT, UPDATE, DELETE ON public.calendar_events, public.calendar_event_reports, public.website_feedback
  FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Storage: the "Service role" partner-logo policies were TO public
-- ---------------------------------------------------------------------------

-- The service role bypasses RLS and needs neither policy. With them, anyone
-- could upload any file to the public bucket or delete every sponsor's logo.
DROP POLICY IF EXISTS "Service role upload for partner logos" ON storage.objects;
DROP POLICY IF EXISTS "Service role delete for partner logos" ON storage.objects;

-- ---------------------------------------------------------------------------
-- 7. TRUNCATE is not governed by RLS. PostgREST cannot issue it, but nothing
--    on the anon or authenticated roles should hold it.
-- ---------------------------------------------------------------------------

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
