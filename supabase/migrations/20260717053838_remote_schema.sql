


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."check_checkin_pin"("p_event_id" "uuid", "p_pin" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN verify_checkin_pin(p_event_id, p_pin);
END;
$$;


ALTER FUNCTION "public"."check_checkin_pin"("p_event_id" "uuid", "p_pin" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_pin" "text", "p_documents" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_event_id UUID;
  v_checkin_id UUID;
  v_doc JSONB;
BEGIN
  -- Get event_id from participant
  SELECT event_id INTO v_event_id FROM participants WHERE id = p_participant_id;
  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Participant not found');
  END IF;

  -- Validate PIN
  IF NOT EXISTS (SELECT 1 FROM event_secrets WHERE event_id = v_event_id AND checkin_pin = p_pin) THEN
    RETURN jsonb_build_object('error', 'Invalid PIN');
  END IF;

  -- Upsert checkins row
  INSERT INTO checkins (participant_id, event_id, checked_in_at)
  VALUES (p_participant_id, v_event_id, NOW())
  ON CONFLICT (participant_id) DO UPDATE SET checked_in_at = NOW(), updated_at = NOW()
  RETURNING id INTO v_checkin_id;

  -- Insert document completions
  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO checkin_documents (checkin_id, document_id, completed_at, completed_by)
    VALUES (
      v_checkin_id,
      (v_doc->>'document_id')::UUID,
      NOW(),
      COALESCE(v_doc->>'completed_by', 'admin')
    )
    ON CONFLICT (checkin_id, document_id) DO UPDATE SET
      completed_at = NOW(),
      completed_by = COALESCE(EXCLUDED.completed_by, checkin_documents.completed_by);
  END LOOP;

  RETURN jsonb_build_object('success', true, 'checkin_id', v_checkin_id);
END;
$$;


ALTER FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_pin" "text", "p_documents" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_event_id" "uuid", "p_pin" "text", "p_documents" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_checkin_id UUID;
  v_pin_valid BOOLEAN;
  v_doc JSONB;
BEGIN
  -- Validate PIN
  SELECT verify_checkin_pin(p_event_id, p_pin) INTO v_pin_valid;
  IF NOT v_pin_valid THEN
    RAISE EXCEPTION 'Invalid PIN';
  END IF;

  -- Insert or update checkin
  INSERT INTO checkins (participant_id, event_id, checked_in_at)
  VALUES (p_participant_id, p_event_id, NOW())
  ON CONFLICT (participant_id) DO UPDATE
  SET checked_in_at = NOW(), updated_at = NOW()
  RETURNING id INTO v_checkin_id;

  -- Insert/update checkin_documents
  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO checkin_documents (
      checkin_id,
      document_id,
      status,
      completed_at,
      completed_by
    )
    VALUES (
      v_checkin_id,
      (v_doc->>'document_id')::UUID,
      v_doc->>'status',
      CASE WHEN v_doc->>'status' IN ('accepted', 'verified') THEN NOW() ELSE NULL END,
      v_doc->>'completed_by'
    )
    ON CONFLICT (checkin_id, document_id) DO UPDATE
    SET
      status = EXCLUDED.status,
      completed_at = EXCLUDED.completed_at,
      completed_by = EXCLUDED.completed_by,
      updated_at = NOW();
  END LOOP;

  -- Return the updated checkin record
  RETURN (
    SELECT jsonb_build_object(
      'id', id,
      'participant_id', participant_id,
      'event_id', event_id,
      'checked_in_at', checked_in_at,
      'created_at', created_at,
      'updated_at', updated_at
    )
    FROM checkins
    WHERE id = v_checkin_id
  );
END;
$$;


ALTER FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_event_id" "uuid", "p_pin" "text", "p_documents" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_or_create_club"("club_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  norm TEXT;
  cid UUID;
BEGIN
  norm := normalize_club_name(club_name);
  IF norm = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO clubs (name, normalized_name)
  VALUES (trim(club_name), norm)
  ON CONFLICT (normalized_name) DO UPDATE SET name = clubs.name
  RETURNING id INTO cid;
  RETURN cid;
END $$;


ALTER FUNCTION "public"."find_or_create_club"("club_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_participant_admin"("p_event_id" "uuid", "p_pin" "text", "p_participant_id" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
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
  WHERE p.id = p_participant_id;

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_participant_admin"("p_event_id" "uuid", "p_pin" "text", "p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_participant_for_checkin"("p_participant_id" "uuid") RETURNS TABLE("id" "uuid", "bib_number" integer, "first_name" "text", "last_name" "text", "birth_date" "date", "category_id" "uuid", "tshirt_size" "text", "phone" "text", "emoji" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
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
  WHERE p.id = p_participant_id;
END;
$$;


ALTER FUNCTION "public"."get_participant_for_checkin"("p_participant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_username_available"("u" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  SELECT u ~ '^[a-z0-9_]{3,30}$'
     AND NOT EXISTS (SELECT 1 FROM profiles WHERE username = u)
$_$;


ALTER FUNCTION "public"."is_username_available"("u" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_clubs"("target" "uuid", "sources" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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
  UPDATE profiles SET club_id = target WHERE club_id = ANY(sources);
  GET DIAGNOSTICS moved = ROW_COUNT;
  DELETE FROM clubs WHERE id = ANY(sources);
  RETURN moved;
END $$;


ALTER FUNCTION "public"."merge_clubs"("target" "uuid", "sources" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_club_name"("input" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      translate(lower(coalesce(input, '')),
        'ąćęłńóśźż',
        'acelnoszz'),
      '[^a-z0-9 ]', '', 'g'),
    ' +', ' ', 'g'))
$$;


ALTER FUNCTION "public"."normalize_club_name"("input" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_calendar_event_changes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Cancellation notifications intentionally removed: we only alert on data we
  -- control (registration URL appearing, deadline approaching). Cancellations
  -- depend on organizers reporting them, which we cannot promise.
  IF (OLD.registration_url IS NULL OR OLD.registration_url = '')
     AND NEW.registration_url IS NOT NULL AND NEW.registration_url <> '' THEN
    INSERT INTO event_notifications (event_id, type) VALUES (NEW.id, 'registration_opened')
    ON CONFLICT (event_id, type) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."notify_calendar_event_changes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_clubs"("q" "text") RETURNS TABLE("id" "uuid", "name" "text", "member_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT c.id, c.name, count(p.id)::bigint AS member_count
  FROM clubs c
  LEFT JOIN profiles p ON p.club_id = c.id
  WHERE normalize_club_name(q) <> ''
    AND (
      c.normalized_name LIKE '%' || normalize_club_name(q) || '%'
      OR word_similarity(normalize_club_name(q), c.normalized_name) > 0.3
    )
  GROUP BY c.id, c.name
  ORDER BY GREATEST(
    word_similarity(normalize_club_name(q), c.normalized_name),
    similarity(c.normalized_name, normalize_club_name(q))
  ) DESC
  LIMIT 8
$$;


ALTER FUNCTION "public"."search_clubs"("q" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_participants_admin"("p_event_id" "uuid", "p_pin" "text", "p_query" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
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
        AND p.bib_number = p_query::INT
    ) t;
  ELSE
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::JSON) INTO result
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
$_$;


ALTER FUNCTION "public"."search_participants_admin"("p_event_id" "uuid", "p_pin" "text", "p_query" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."similar_club_pairs"("threshold" real DEFAULT 0.45) RETURNS TABLE("a_id" "uuid", "a_name" "text", "b_id" "uuid", "b_name" "text", "sim" real)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT a.id, a.name, b.id, b.name,
         similarity(a.normalized_name, b.normalized_name) AS sim
  FROM clubs a
  JOIN clubs b ON a.id < b.id
  WHERE similarity(a.normalized_name, b.normalized_name) >= threshold
  ORDER BY sim DESC
$$;


ALTER FUNCTION "public"."similar_club_pairs"("threshold" real) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_checkin_documents_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_checkin_documents_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_checkins_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_checkins_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_checkin_pin"("p_event_id" "uuid", "p_pin" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  pin_valid BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM event_secrets
    WHERE event_id = p_event_id
    AND checkin_pin = p_pin
  ) INTO pin_valid;
  
  RETURN pin_valid;
END;
$$;


ALTER FUNCTION "public"."verify_checkin_pin"("p_event_id" "uuid", "p_pin" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "admin_user_id" "uuid",
    "action" "text" NOT NULL,
    "target_table" "text",
    "target_id" "text",
    "payload" "jsonb",
    "ip_inet" "inet",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auth_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "code_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "used" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "purpose" "text" DEFAULT 'login'::"text" NOT NULL,
    CONSTRAINT "auth_codes_purpose_check" CHECK (("purpose" = ANY (ARRAY['login'::"text", 'delete_account'::"text"])))
);


ALTER TABLE "public"."auth_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auth_sessions" (
    "id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."auth_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."badge_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "icon" "text" NOT NULL,
    "condition_type" "text" NOT NULL,
    "condition_value" integer,
    "name_female" "text"
);


ALTER TABLE "public"."badge_definitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_event_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "calendar_event_id" "uuid" NOT NULL,
    "field" "text" NOT NULL,
    "old_value" "text",
    "suggested_value" "text",
    "source_url" "text",
    "note" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "user_id" "uuid"
);


ALTER TABLE "public"."calendar_event_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text",
    "voivodeship" "text",
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "event_type" "text"[],
    "distances" "text"[],
    "registration_url" "text",
    "registration_deadline" "date",
    "price_from" integer,
    "price_to" integer,
    "website" "text",
    "source" "text" NOT NULL,
    "source_url" "text",
    "source_id" "text",
    "leszyrun_event_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text",
    "last_verified_at" timestamp with time zone DEFAULT "now"(),
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "enriched_at" timestamp with time zone,
    "source_links" "jsonb" DEFAULT '[]'::"jsonb",
    "regulamin_url" "text",
    "locked_fields" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "community_locked_fields" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "submitted_by" "uuid"
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."calendar_events"."locked_fields" IS 'Array of column names whose value must not be overwritten by automated writers (enricher sync, future publish-merge paths). Admin UI edits append to this. Human admins may clear entries directly.';



CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "synced_at" timestamp with time zone,
    "untimed" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkin_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "checkin_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "completed_at" timestamp with time zone,
    "completed_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status" "text"
);


ALTER TABLE "public"."checkin_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "checked_in_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."checkins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkpoint_categories" (
    "checkpoint_id" "uuid" NOT NULL,
    "category_id" "uuid" NOT NULL
);


ALTER TABLE "public"."checkpoint_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkpoint_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "race_run_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"(),
    "file_name" "text"
);


ALTER TABLE "public"."checkpoint_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkpoint_observations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "checkpoint_id" "uuid" NOT NULL,
    "bib_number" integer NOT NULL,
    "participant_id" "uuid",
    "observed_at" timestamp with time zone NOT NULL,
    "synced_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."checkpoint_observations" REPLICA IDENTITY FULL;


ALTER TABLE "public"."checkpoint_observations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkpoint_readings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_id" "uuid" NOT NULL,
    "epc" "text" NOT NULL,
    "participant_id" "uuid",
    "recorded_at" timestamp with time zone NOT NULL,
    "rssi_cdbm" integer
);


ALTER TABLE "public"."checkpoint_readings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkpoints" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "km_marker" numeric(6,2),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "synced_at" timestamp with time zone,
    "private" boolean DEFAULT false,
    "is_near_finish" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."checkpoints" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clubs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."clubs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."consent_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "decision" "text" NOT NULL,
    "policy_version" "text" NOT NULL,
    "ip_inet" "inet",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "consent_log_decision_check" CHECK (("decision" = ANY (ARRAY['accepted'::"text", 'rejected'::"text", 'withdrawn'::"text"])))
);


ALTER TABLE "public"."consent_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dismissed_duplicates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id_1" "uuid" NOT NULL,
    "event_id_2" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dismissed_duplicates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "category_id" "uuid",
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text",
    "gender" "text",
    "club" "text",
    "bib_number" integer,
    "rfid_epc" "text",
    "checked_in" boolean DEFAULT false NOT NULL,
    "checked_in_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "synced_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "emoji" "text",
    "birth_date" "date",
    "phone" "text",
    "sms_sent_at" timestamp with time zone,
    "tshirt_size" "text",
    "deleted_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."participants" REPLICA IDENTITY FULL;


ALTER TABLE "public"."participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."race_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "synced_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."race_runs" REPLICA IDENTITY FULL;


ALTER TABLE "public"."race_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "race_run_id" "uuid" NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "start_time" timestamp with time zone,
    "finish_time" timestamp with time zone,
    "duration_ms" bigint,
    "start_crossing_id" "uuid",
    "finish_crossing_id" "uuid",
    "position" integer,
    "status" "text" DEFAULT 'registered'::"text" NOT NULL,
    "status_note" "text",
    "manual_override" boolean DEFAULT false NOT NULL,
    "synced_at" timestamp with time zone,
    "gun_duration_ms" bigint,
    "start_time_source" "text",
    "start_time_trigger" "text"
);

ALTER TABLE ONLY "public"."results" REPLICA IDENTITY FULL;


ALTER TABLE "public"."results" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."event_category_best_times" AS
 WITH "timed_categories" AS (
         SELECT "c"."id" AS "category_id",
            "c"."event_id",
            "c"."name"
           FROM "public"."categories" "c"
          WHERE ("c"."untimed" = false)
        ), "live_runs" AS (
         SELECT "rr"."id" AS "race_run_id",
            "tc"."event_id",
            "tc"."name" AS "category"
           FROM ("public"."race_runs" "rr"
             JOIN "timed_categories" "tc" ON (("tc"."category_id" = "rr"."category_id")))
          WHERE ("rr"."status" <> 'cancelled'::"text")
        )
 SELECT "lr"."event_id",
    "lr"."category",
    "p"."gender",
    "min"("r"."duration_ms") AS "best_ms"
   FROM (("public"."results" "r"
     JOIN "live_runs" "lr" ON (("lr"."race_run_id" = "r"."race_run_id")))
     JOIN "public"."participants" "p" ON (("p"."id" = "r"."participant_id")))
  WHERE (("r"."status" = 'finished'::"text") AND ("r"."duration_ms" IS NOT NULL) AND ("p"."gender" = ANY (ARRAY['M'::"text", 'K'::"text"])))
  GROUP BY "lr"."event_id", "lr"."category", "p"."gender";


ALTER VIEW "public"."event_category_best_times" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "url" "text",
    "required_for" "text" DEFAULT 'all'::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone
);


ALTER TABLE "public"."event_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_favorites" (
    "user_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_favorites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "event_notifications_type_check" CHECK (("type" = ANY (ARRAY['registration_opened'::"text", 'deadline_soon'::"text"])))
);


ALTER TABLE "public"."event_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_partners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "logo_url" "text",
    "website_url" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."event_partners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "date" "text",
    "location" "text",
    "rfid_mode" "text" DEFAULT 'single'::"text" NOT NULL,
    "rfid_topic_main" "text" DEFAULT 'beepbeep'::"text" NOT NULL,
    "rfid_topic_finish" "text" DEFAULT 'beepbeep/finish'::"text" NOT NULL,
    "rssi_threshold" integer DEFAULT '-5000'::integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "synced_at" timestamp with time zone,
    "decline_threshold_cdbm" integer DEFAULT 1000 NOT NULL,
    "gone_window_seconds" integer DEFAULT 3 NOT NULL,
    "fallback_seconds" integer DEFAULT 10 NOT NULL,
    "slug" "text",
    "public_results_url" "text",
    "gun_backfill_seconds" integer DEFAULT 60 NOT NULL,
    "event_url" "text",
    "visibility" "text" DEFAULT 'private'::"text" NOT NULL
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."event_results_summary" AS
 WITH "timed_categories" AS (
         SELECT "c"."id" AS "category_id",
            "c"."event_id",
            "c"."name"
           FROM "public"."categories" "c"
          WHERE ("c"."untimed" = false)
        ), "live_runs" AS (
         SELECT "rr"."id" AS "race_run_id",
            "tc"."event_id"
           FROM ("public"."race_runs" "rr"
             JOIN "timed_categories" "tc" ON (("tc"."category_id" = "rr"."category_id")))
          WHERE ("rr"."status" <> 'cancelled'::"text")
        ), "finished" AS (
         SELECT "lr"."event_id",
            "r"."duration_ms",
            "r"."participant_id"
           FROM ("public"."results" "r"
             JOIN "live_runs" "lr" ON (("lr"."race_run_id" = "r"."race_run_id")))
          WHERE ("r"."status" = 'finished'::"text")
        ), "fastest" AS (
         SELECT DISTINCT ON ("f"."event_id") "f"."event_id",
            "f"."duration_ms",
            "p"."first_name",
            "p"."last_name"
           FROM ("finished" "f"
             JOIN "public"."participants" "p" ON (("p"."id" = "f"."participant_id")))
          WHERE ("f"."duration_ms" IS NOT NULL)
          ORDER BY "f"."event_id", "f"."duration_ms"
        )
 SELECT "e"."id" AS "event_id",
    ( SELECT "count"(*) AS "count"
           FROM "public"."participants" "pp"
          WHERE ("pp"."event_id" = "e"."id")) AS "participants",
    ( SELECT "count"(*) AS "count"
           FROM "finished" "ff"
          WHERE ("ff"."event_id" = "e"."id")) AS "finishers",
    COALESCE(( SELECT "array_agg"("tc"."name" ORDER BY "tc"."name") AS "array_agg"
           FROM ( SELECT DISTINCT "timed_categories"."name"
                   FROM "timed_categories"
                  WHERE ("timed_categories"."event_id" = "e"."id")) "tc"), '{}'::"text"[]) AS "distances",
    "fa"."duration_ms" AS "fastest_ms",
        CASE
            WHEN ("fa"."event_id" IS NOT NULL) THEN "btrim"("concat"("fa"."first_name", ' ', "fa"."last_name"))
            ELSE NULL::"text"
        END AS "fastest_name"
   FROM ("public"."events" "e"
     LEFT JOIN "fastest" "fa" ON (("fa"."event_id" = "e"."id")));


ALTER VIEW "public"."event_results_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_secrets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "checkin_pin" "text" NOT NULL
);


ALTER TABLE "public"."event_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gate_crossings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "race_run_id" "uuid" NOT NULL,
    "participant_id" "uuid" NOT NULL,
    "gate" "text" NOT NULL,
    "crossing_number" integer NOT NULL,
    "confirmed_at" timestamp with time zone NOT NULL,
    "peak_rssi_cdbm" integer,
    "antenna_port" integer,
    "synced_at" timestamp with time zone
);


ALTER TABLE "public"."gate_crossings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gate_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "race_run_id" "uuid",
    "topic" "text" NOT NULL,
    "epc" "text" NOT NULL,
    "antenna_port" integer NOT NULL,
    "rssi_cdbm" integer NOT NULL,
    "frequency" integer,
    "raw" "jsonb" NOT NULL,
    "received_at" timestamp with time zone NOT NULL,
    "crossing_id" "uuid"
);


ALTER TABLE "public"."gate_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."geocode_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "location_query" "text" NOT NULL,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "voivodeship" "text"
);


ALTER TABLE "public"."geocode_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email_enabled" boolean DEFAULT true NOT NULL,
    "push_enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."otp_throttle" (
    "key" "text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "window_started_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."otp_throttle" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."participants_public" AS
 SELECT "id",
    "bib_number",
    "first_name",
    "last_name",
    "club",
    "category_id",
    "emoji",
    "gender",
    "deleted_at"
   FROM "public"."participants";


ALTER VIEW "public"."participants_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pin_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "success" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."pin_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "text",
    "display_name" "text",
    "avatar_url" "text",
    "bio" "text",
    "privacy_settings" "jsonb" DEFAULT '{"bio": true, "club": true, "favorites": true, "display_name": true}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text",
    "club_id" "uuid",
    "gender" "text",
    "phone" "text",
    "date_of_birth" "date",
    "city" "text",
    "voivodeship" "text",
    "deleted_at" timestamp with time zone,
    "notifications_seen_at" timestamp with time zone,
    "weekly_digest" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_gender_check" CHECK ((("gender" IS NULL) OR ("gender" = ANY (ARRAY['M'::"text", 'F'::"text", 'X'::"text"]))))
);

ALTER TABLE ONLY "public"."profiles" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."profiles_public" AS
 SELECT "p"."id",
    "p"."username",
        CASE
            WHEN (("p"."privacy_settings" ->> 'display_name'::"text"))::boolean THEN "p"."display_name"
            ELSE NULL::"text"
        END AS "display_name",
        CASE
            WHEN (("p"."privacy_settings" ->> 'club'::"text"))::boolean THEN "c"."name"
            ELSE NULL::"text"
        END AS "club",
        CASE
            WHEN (("p"."privacy_settings" ->> 'bio'::"text"))::boolean THEN "p"."bio"
            ELSE NULL::"text"
        END AS "bio",
    "p"."avatar_url",
    "p"."created_at"
   FROM ("public"."profiles" "p"
     LEFT JOIN "public"."clubs" "c" ON (("c"."id" = "p"."club_id")));


ALTER VIEW "public"."profiles_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_aleczas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric(10,2),
    "price_to" numeric(10,2),
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "registration_deadline" "date"
);


ALTER TABLE "public"."scraper_aleczas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_all" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "registration_deadline" "date",
    "location" "text",
    "voivodeship" "text",
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "distances" "text",
    "event_type" "text",
    "event_types" "text"[],
    "registration_url" "text",
    "regulamin_url" "text",
    "regulamin_urls" "text"[],
    "website" "text",
    "is_kids" boolean DEFAULT false NOT NULL,
    "source" "text" NOT NULL,
    "source_id" "text",
    "source_url" "text",
    "source_links" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "merged_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "enriched_regulamin_at" timestamp with time zone,
    "enriched_search_at" timestamp with time zone,
    "price_from" integer,
    "price_to" integer,
    "enriched_at" timestamp with time zone
);


ALTER TABLE "public"."scraper_all" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_b4sport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "regulamin_url" "text",
    "website" "text"
);


ALTER TABLE "public"."scraper_b4sport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_bgtimesport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "price_from" numeric,
    "price_to" numeric,
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "event_types" "text"[]
);


ALTER TABLE "public"."scraper_bgtimesport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_biegiwpolsce" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text",
    "voivodeship" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "known_source_link" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "event_types" "text"[],
    "distances" "text",
    "is_kids" boolean DEFAULT false NOT NULL,
    "merged_at" timestamp with time zone
);


ALTER TABLE "public"."scraper_biegiwpolsce" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_biegnijmy" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_biegnijmy" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_czasomierzyk" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_czasomierzyk" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_datasport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text",
    "distances" "text",
    "regulamin_url" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "merged_at" timestamp with time zone,
    "registration_url" "text"
);


ALTER TABLE "public"."scraper_datasport" OWNER TO "postgres";


COMMENT ON COLUMN "public"."scraper_datasport"."registration_url" IS 'Canonical datasport registration URL: https://online.datasport.pl/zapisy/portal/baza/wizardnew/?zawody=<id>';



CREATE TABLE IF NOT EXISTS "public"."scraper_dostartu" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "end_date" "date",
    "location" "text",
    "lat" numeric,
    "lng" numeric,
    "distances" "text",
    "event_type" "text",
    "registration_url" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "is_kids" boolean DEFAULT false NOT NULL,
    "regulamin_url" "text",
    "merged_at" timestamp with time zone,
    "registration_deadline" "date",
    "price_from" numeric,
    "price_to" numeric,
    "website" "text"
);


ALTER TABLE "public"."scraper_dostartu" OWNER TO "postgres";


COMMENT ON COLUMN "public"."scraper_dostartu"."price_from" IS 'Min price across all classificationPrices.price tiers (PLN). Set by dostartu scraper from API.';



COMMENT ON COLUMN "public"."scraper_dostartu"."price_to" IS 'Max price across all classificationPrices.price tiers (PLN). Set by dostartu scraper from API.';



COMMENT ON COLUMN "public"."scraper_dostartu"."website" IS 'Organizer external website (dostartu API: competition.websitePl). Distinct from registration_url which is always the dostartu permalink.';



CREATE TABLE IF NOT EXISTS "public"."scraper_egepard" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_egepard" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_elektronicznezapisy" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_urls" "text"[],
    "external_website" "text",
    "known_source_link" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "merged_at" timestamp with time zone,
    "price_from" integer,
    "price_to" integer,
    "registration_deadline" "date",
    "is_kids" boolean DEFAULT false,
    "website" "text",
    "regulamin_url" "text",
    "lat" numeric,
    "lng" numeric
);


ALTER TABLE "public"."scraper_elektronicznezapisy" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_foxter" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_foxter" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_herkules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "event_types" "text"[],
    "is_kids" boolean DEFAULT false,
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_herkules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_inessport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric(10,2),
    "price_to" numeric(10,2),
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_inessport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_kepasport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric(9,2),
    "price_to" numeric(9,2),
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_kepasport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_lumisport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "price_from" numeric,
    "price_to" numeric,
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_lumisport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_maratonczykpomiarczasu" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "voivodeship" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_maratonczykpomiarczasu" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_maratonypolskie" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text",
    "distances" "text",
    "source_id" "text",
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "merged_at" timestamp with time zone
);


ALTER TABLE "public"."scraper_maratonypolskie" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_pifsport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_pifsport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_plustiming" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_plustiming" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_pomiaryczasu" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_pomiaryczasu" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_protiming24" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "event_types" "text"[]
);


ALTER TABLE "public"."scraper_protiming24" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_raatiming" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "distances" "text",
    "registration_url" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "regulamin_url" "text",
    "website" "text"
);


ALTER TABLE "public"."scraper_raatiming" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_rajsportactive" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_rajsportactive" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_sporttime" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric(9,2),
    "price_to" numeric(9,2),
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_sporttime" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_superczas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_superczas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_supersport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_supersport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_timekeeper" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_timekeeper" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_timesport" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "voivodeship" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_timesport" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_timing4u" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric(10,2),
    "price_to" numeric(10,2),
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_timing4u" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_wbtiming" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric(10,2),
    "price_to" numeric(10,2),
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_wbtiming" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_zapisyonline" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_zapisyonline" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_zapisyvaldano" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "text" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "registration_deadline" "date",
    "regulamin_url" "text",
    "website" "text",
    "is_kids" boolean DEFAULT false,
    "event_types" "text"[],
    "price_from" numeric,
    "price_to" numeric,
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "merged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."scraper_zapisyvaldano" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scraper_zmierzymyczas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "date" "date" NOT NULL,
    "location" "text",
    "distances" "text",
    "registration_url" "text",
    "regulamin_url" "text",
    "source_id" "text" NOT NULL,
    "source_url" "text",
    "scraped_at" timestamp with time zone DEFAULT "now"(),
    "merged_at" timestamp with time zone,
    "website" "text"
);


ALTER TABLE "public"."scraper_zmierzymyczas" OWNER TO "postgres";


COMMENT ON COLUMN "public"."scraper_zmierzymyczas"."website" IS 'External organizer site if known, else falls back to the public info page URL (zmierzymyczas.pl/<id>/<slug>.html). Distinct from registration_url which is the /edit/<id>/<slug>.html sign-up form.';



CREATE TABLE IF NOT EXISTS "public"."url_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "calendar_event_id" "uuid" NOT NULL,
    "search_query" "text" NOT NULL,
    "search_engine" "text" DEFAULT 'brave'::"text",
    "rank" integer NOT NULL,
    "url" "text" NOT NULL,
    "page_title" "text",
    "snippet" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "reviewed_by" "text",
    "reviewed_at" timestamp with time zone,
    "rejection_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."url_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_badges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "badge_id" "uuid" NOT NULL,
    "awarded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_badges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."website_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category" "text" NOT NULL,
    "message" "text" NOT NULL,
    "email" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "admin_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "user_id" "uuid",
    CONSTRAINT "website_feedback_category_check" CHECK (("category" = ANY (ARRAY['missing_feature'::"text", 'bug'::"text", 'content'::"text", 'other'::"text"]))),
    CONSTRAINT "website_feedback_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."website_feedback" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_codes"
    ADD CONSTRAINT "auth_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_sessions"
    ADD CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."badge_definitions"
    ADD CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."badge_definitions"
    ADD CONSTRAINT "badge_definitions_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."calendar_event_reports"
    ADD CONSTRAINT "calendar_event_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_event_id_slug_unique" UNIQUE ("event_id", "slug");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkin_documents"
    ADD CONSTRAINT "checkin_documents_checkin_id_document_id_key" UNIQUE ("checkin_id", "document_id");



ALTER TABLE ONLY "public"."checkin_documents"
    ADD CONSTRAINT "checkin_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkins"
    ADD CONSTRAINT "checkins_participant_id_key" UNIQUE ("participant_id");



ALTER TABLE ONLY "public"."checkins"
    ADD CONSTRAINT "checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkpoint_categories"
    ADD CONSTRAINT "checkpoint_categories_pkey" PRIMARY KEY ("checkpoint_id", "category_id");



ALTER TABLE ONLY "public"."checkpoint_imports"
    ADD CONSTRAINT "checkpoint_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkpoint_observations"
    ADD CONSTRAINT "checkpoint_observations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkpoint_readings"
    ADD CONSTRAINT "checkpoint_readings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkpoints"
    ADD CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clubs"
    ADD CONSTRAINT "clubs_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."clubs"
    ADD CONSTRAINT "clubs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consent_log"
    ADD CONSTRAINT "consent_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dismissed_duplicates"
    ADD CONSTRAINT "dismissed_duplicates_event_id_1_event_id_2_key" UNIQUE ("event_id_1", "event_id_2");



ALTER TABLE ONLY "public"."dismissed_duplicates"
    ADD CONSTRAINT "dismissed_duplicates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_documents"
    ADD CONSTRAINT "event_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_favorites"
    ADD CONSTRAINT "event_favorites_pkey" PRIMARY KEY ("user_id", "event_id");



ALTER TABLE ONLY "public"."event_notifications"
    ADD CONSTRAINT "event_notifications_event_id_type_key" UNIQUE ("event_id", "type");



ALTER TABLE ONLY "public"."event_notifications"
    ADD CONSTRAINT "event_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_partners"
    ADD CONSTRAINT "event_partners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_secrets"
    ADD CONSTRAINT "event_secrets_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."event_secrets"
    ADD CONSTRAINT "event_secrets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."gate_crossings"
    ADD CONSTRAINT "gate_crossings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gate_events"
    ADD CONSTRAINT "gate_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."geocode_cache"
    ADD CONSTRAINT "geocode_cache_location_query_key" UNIQUE ("location_query");



ALTER TABLE ONLY "public"."geocode_cache"
    ADD CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."otp_throttle"
    ADD CONSTRAINT "otp_throttle_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_event_id_bib_number_unique" UNIQUE ("event_id", "bib_number");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_event_id_rfid_epc_unique" UNIQUE ("event_id", "rfid_epc");



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pin_attempts"
    ADD CONSTRAINT "pin_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."race_runs"
    ADD CONSTRAINT "race_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."results"
    ADD CONSTRAINT "results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."results"
    ADD CONSTRAINT "results_race_run_id_participant_id_unique" UNIQUE ("race_run_id", "participant_id");



ALTER TABLE ONLY "public"."scraper_aleczas"
    ADD CONSTRAINT "scraper_aleczas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_all"
    ADD CONSTRAINT "scraper_all_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_all"
    ADD CONSTRAINT "scraper_all_source_source_id_key" UNIQUE ("source", "source_id");



ALTER TABLE ONLY "public"."scraper_b4sport"
    ADD CONSTRAINT "scraper_b4sport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_b4sport"
    ADD CONSTRAINT "scraper_b4sport_source_id_key" UNIQUE ("source_id");



ALTER TABLE ONLY "public"."scraper_bgtimesport"
    ADD CONSTRAINT "scraper_bgtimesport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_biegiwpolsce"
    ADD CONSTRAINT "scraper_biegiwpolsce_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_biegnijmy"
    ADD CONSTRAINT "scraper_biegnijmy_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_czasomierzyk"
    ADD CONSTRAINT "scraper_czasomierzyk_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_datasport"
    ADD CONSTRAINT "scraper_datasport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_dostartu"
    ADD CONSTRAINT "scraper_dostartu_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_egepard"
    ADD CONSTRAINT "scraper_egepard_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_elektronicznezapisy"
    ADD CONSTRAINT "scraper_elektronicznezapisy_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_foxter"
    ADD CONSTRAINT "scraper_foxter_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_herkules"
    ADD CONSTRAINT "scraper_herkules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_inessport"
    ADD CONSTRAINT "scraper_inessport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_kepasport"
    ADD CONSTRAINT "scraper_kepasport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_lumisport"
    ADD CONSTRAINT "scraper_lumisport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_maratonczykpomiarczasu"
    ADD CONSTRAINT "scraper_maratonczykpomiarczasu_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_maratonypolskie"
    ADD CONSTRAINT "scraper_maratonypolskie_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_pifsport"
    ADD CONSTRAINT "scraper_pifsport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_plustiming"
    ADD CONSTRAINT "scraper_plustiming_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_pomiaryczasu"
    ADD CONSTRAINT "scraper_pomiaryczasu_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_protiming24"
    ADD CONSTRAINT "scraper_protiming24_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_raatiming"
    ADD CONSTRAINT "scraper_raatiming_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_raatiming"
    ADD CONSTRAINT "scraper_raatiming_source_id_key" UNIQUE ("source_id");



ALTER TABLE ONLY "public"."scraper_rajsportactive"
    ADD CONSTRAINT "scraper_rajsportactive_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_sporttime"
    ADD CONSTRAINT "scraper_sporttime_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_superczas"
    ADD CONSTRAINT "scraper_superczas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_supersport"
    ADD CONSTRAINT "scraper_supersport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_timekeeper"
    ADD CONSTRAINT "scraper_timekeeper_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_timekeeper"
    ADD CONSTRAINT "scraper_timekeeper_source_id_key" UNIQUE ("source_id");



ALTER TABLE ONLY "public"."scraper_timesport"
    ADD CONSTRAINT "scraper_timesport_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_timing4u"
    ADD CONSTRAINT "scraper_timing4u_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_wbtiming"
    ADD CONSTRAINT "scraper_wbtiming_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_zapisyonline"
    ADD CONSTRAINT "scraper_zapisyonline_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_zapisyvaldano"
    ADD CONSTRAINT "scraper_zapisyvaldano_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_zmierzymyczas"
    ADD CONSTRAINT "scraper_zmierzymyczas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scraper_zmierzymyczas"
    ADD CONSTRAINT "scraper_zmierzymyczas_source_id_key" UNIQUE ("source_id");



ALTER TABLE ONLY "public"."url_suggestions"
    ADD CONSTRAINT "url_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_user_id_badge_id_key" UNIQUE ("user_id", "badge_id");



ALTER TABLE ONLY "public"."website_feedback"
    ADD CONSTRAINT "website_feedback_pkey" PRIMARY KEY ("id");



CREATE INDEX "admin_actions_admin_user_id_idx" ON "public"."admin_actions" USING "btree" ("admin_user_id");



CREATE INDEX "admin_actions_created_at_idx" ON "public"."admin_actions" USING "btree" ("created_at");



CREATE INDEX "auth_codes_email_idx" ON "public"."auth_codes" USING "btree" ("email");



CREATE INDEX "auth_sessions_user_id_idx" ON "public"."auth_sessions" USING "btree" ("user_id");



CREATE INDEX "clubs_normalized_trgm_idx" ON "public"."clubs" USING "gin" ("normalized_name" "public"."gin_trgm_ops");



CREATE INDEX "consent_log_created_at_idx" ON "public"."consent_log" USING "btree" ("created_at");



CREATE INDEX "consent_log_user_id_idx" ON "public"."consent_log" USING "btree" ("user_id");



CREATE INDEX "event_favorites_event_idx" ON "public"."event_favorites" USING "btree" ("event_id");



CREATE INDEX "event_notifications_event_idx" ON "public"."event_notifications" USING "btree" ("event_id");



CREATE INDEX "gate_events_epc_idx" ON "public"."gate_events" USING "btree" ("epc");



CREATE INDEX "gate_events_received_at_idx" ON "public"."gate_events" USING "btree" ("received_at");



CREATE INDEX "idx_calendar_events_date" ON "public"."calendar_events" USING "btree" ("date");



CREATE INDEX "idx_calendar_events_source" ON "public"."calendar_events" USING "btree" ("source", "source_id");



CREATE INDEX "idx_calendar_events_status" ON "public"."calendar_events" USING "btree" ("status");



CREATE INDEX "idx_calendar_events_voivodeship" ON "public"."calendar_events" USING "btree" ("voivodeship");



CREATE INDEX "idx_dismissed_duplicates_events" ON "public"."dismissed_duplicates" USING "btree" ("event_id_1", "event_id_2");



CREATE INDEX "idx_event_partners_event_id" ON "public"."event_partners" USING "btree" ("event_id");



CREATE INDEX "idx_events_submitted_by" ON "public"."calendar_events" USING "btree" ("submitted_by");



CREATE INDEX "idx_feedback_user_id" ON "public"."website_feedback" USING "btree" ("user_id");



CREATE INDEX "idx_pin_attempts_event_time" ON "public"."pin_attempts" USING "btree" ("event_id", "attempted_at");



CREATE INDEX "idx_reports_event_id" ON "public"."calendar_event_reports" USING "btree" ("calendar_event_id");



CREATE INDEX "idx_reports_status" ON "public"."calendar_event_reports" USING "btree" ("status");



CREATE INDEX "idx_reports_user_id" ON "public"."calendar_event_reports" USING "btree" ("user_id");



CREATE INDEX "idx_scraper_b4sport_date" ON "public"."scraper_b4sport" USING "btree" ("date");



CREATE INDEX "idx_scraper_b4sport_merged_at" ON "public"."scraper_b4sport" USING "btree" ("merged_at");



CREATE UNIQUE INDEX "idx_scraper_bwp_source" ON "public"."scraper_biegiwpolsce" USING "btree" ("source_id");



CREATE UNIQUE INDEX "idx_scraper_ds_source" ON "public"."scraper_datasport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "idx_scraper_dst_source" ON "public"."scraper_dostartu" USING "btree" ("source_id");



CREATE UNIQUE INDEX "idx_scraper_ez_source" ON "public"."scraper_elektronicznezapisy" USING "btree" ("source_id");



CREATE UNIQUE INDEX "idx_scraper_mp_source" ON "public"."scraper_maratonypolskie" USING "btree" ("source_id");



CREATE INDEX "idx_url_suggestions_event" ON "public"."url_suggestions" USING "btree" ("calendar_event_id");



CREATE INDEX "idx_url_suggestions_status" ON "public"."url_suggestions" USING "btree" ("status");



CREATE INDEX "participants_active_idx" ON "public"."participants" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "profiles_active_idx" ON "public"."profiles" USING "btree" ("id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "profiles_club_id_idx" ON "public"."profiles" USING "btree" ("club_id");



CREATE UNIQUE INDEX "profiles_email_key" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "results_position_idx" ON "public"."results" USING "btree" ("race_run_id", "position");



CREATE INDEX "results_race_run_id_idx" ON "public"."results" USING "btree" ("race_run_id");



CREATE UNIQUE INDEX "scraper_aleczas_source_id_idx" ON "public"."scraper_aleczas" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_bgtimesport_source_id_idx" ON "public"."scraper_bgtimesport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_biegnijmy_source_id_idx" ON "public"."scraper_biegnijmy" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_czasomierzyk_source_id_idx" ON "public"."scraper_czasomierzyk" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_egepard_source_id_idx" ON "public"."scraper_egepard" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_foxter_source_id_idx" ON "public"."scraper_foxter" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_herkules_source_id_idx" ON "public"."scraper_herkules" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_inessport_source_id_idx" ON "public"."scraper_inessport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_kepasport_source_id_idx" ON "public"."scraper_kepasport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_lumisport_source_id_idx" ON "public"."scraper_lumisport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_maratonczykpomiarczasu_source_id_idx" ON "public"."scraper_maratonczykpomiarczasu" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_pifsport_source_id_idx" ON "public"."scraper_pifsport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_plustiming_source_id_idx" ON "public"."scraper_plustiming" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_pomiaryczasu_source_id_idx" ON "public"."scraper_pomiaryczasu" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_protiming24_source_id_idx" ON "public"."scraper_protiming24" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_rajsportactive_source_id_idx" ON "public"."scraper_rajsportactive" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_sporttime_source_id_idx" ON "public"."scraper_sporttime" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_superczas_source_id_idx" ON "public"."scraper_superczas" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_supersport_source_id_idx" ON "public"."scraper_supersport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_timesport_source_id_idx" ON "public"."scraper_timesport" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_timing4u_source_id_idx" ON "public"."scraper_timing4u" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_wbtiming_source_id_idx" ON "public"."scraper_wbtiming" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_zapisyonline_source_id_idx" ON "public"."scraper_zapisyonline" USING "btree" ("source_id");



CREATE UNIQUE INDEX "scraper_zapisyvaldano_source_id_idx" ON "public"."scraper_zapisyvaldano" USING "btree" ("source_id");



CREATE OR REPLACE TRIGGER "trg_checkin_documents_updated_at" BEFORE UPDATE ON "public"."checkin_documents" FOR EACH ROW EXECUTE FUNCTION "public"."update_checkin_documents_updated_at"();



CREATE OR REPLACE TRIGGER "trg_checkins_updated_at" BEFORE UPDATE ON "public"."checkins" FOR EACH ROW EXECUTE FUNCTION "public"."update_checkins_updated_at"();



CREATE OR REPLACE TRIGGER "trg_notify_calendar_event_changes" AFTER UPDATE ON "public"."calendar_events" FOR EACH ROW EXECUTE FUNCTION "public"."notify_calendar_event_changes"();



ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."auth_sessions"
    ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_reports"
    ADD CONSTRAINT "calendar_event_reports_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_reports"
    ADD CONSTRAINT "calendar_event_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkin_documents"
    ADD CONSTRAINT "checkin_documents_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "public"."checkins"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkin_documents"
    ADD CONSTRAINT "checkin_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."event_documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkins"
    ADD CONSTRAINT "checkins_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkins"
    ADD CONSTRAINT "checkins_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkpoint_categories"
    ADD CONSTRAINT "checkpoint_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkpoint_categories"
    ADD CONSTRAINT "checkpoint_categories_checkpoint_id_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkpoint_imports"
    ADD CONSTRAINT "checkpoint_imports_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkpoint_observations"
    ADD CONSTRAINT "checkpoint_observations_checkpoint_id_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkpoint_observations"
    ADD CONSTRAINT "checkpoint_observations_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."checkpoint_readings"
    ADD CONSTRAINT "checkpoint_readings_import_id_checkpoint_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."checkpoint_imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkpoint_readings"
    ADD CONSTRAINT "checkpoint_readings_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."checkpoints"
    ADD CONSTRAINT "checkpoints_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_log"
    ADD CONSTRAINT "consent_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_documents"
    ADD CONSTRAINT "event_documents_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_favorites"
    ADD CONSTRAINT "event_favorites_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_favorites"
    ADD CONSTRAINT "event_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_notifications"
    ADD CONSTRAINT "event_notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_partners"
    ADD CONSTRAINT "event_partners_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_secrets"
    ADD CONSTRAINT "event_secrets_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gate_crossings"
    ADD CONSTRAINT "gate_crossings_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gate_crossings"
    ADD CONSTRAINT "gate_crossings_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gate_events"
    ADD CONSTRAINT "gate_events_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."participants"
    ADD CONSTRAINT "participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."race_runs"
    ADD CONSTRAINT "race_runs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."results"
    ADD CONSTRAINT "results_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."results"
    ADD CONSTRAINT "results_race_run_id_race_runs_id_fk" FOREIGN KEY ("race_run_id") REFERENCES "public"."race_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."url_suggestions"
    ADD CONSTRAINT "url_suggestions_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "public"."badge_definitions"("id");



ALTER TABLE ONLY "public"."user_badges"
    ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."website_feedback"
    ADD CONSTRAINT "website_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



CREATE POLICY "Allow anon read" ON "public"."scraper_supersport" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Allow service write" ON "public"."scraper_supersport" TO "service_role" USING (true);



CREATE POLICY "Anon insert" ON "public"."checkin_documents" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."checkins" "c"
  WHERE ("c"."id" = "checkin_documents"."checkin_id"))));



CREATE POLICY "Anon insert once" ON "public"."checkins" FOR INSERT WITH CHECK ((NOT (EXISTS ( SELECT 1
   FROM "public"."checkins" "existing"
  WHERE ("existing"."participant_id" = "checkins"."participant_id")))));



CREATE POLICY "Anyone can create reports" ON "public"."calendar_event_reports" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "Anyone can read badges" ON "public"."user_badges" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Anyone can submit pending events" ON "public"."calendar_events" FOR INSERT TO "anon" WITH CHECK (("status" = 'pending'::"text"));



CREATE POLICY "Owner reads own notification prefs" ON "public"."notification_preferences" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Public read" ON "public"."checkin_documents" FOR SELECT USING (true);



CREATE POLICY "Public read" ON "public"."checkins" FOR SELECT USING (true);



CREATE POLICY "Public read" ON "public"."event_documents" FOR SELECT USING (true);



CREATE POLICY "Public read clubs" ON "public"."clubs" FOR SELECT USING (true);



ALTER TABLE "public"."admin_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anon insert observations" ON "public"."checkpoint_observations" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "anon read categories" ON "public"."categories" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read checkpoint_categories" ON "public"."checkpoint_categories" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read checkpoints" ON "public"."checkpoints" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read events" ON "public"."events" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read gate_crossings" ON "public"."gate_crossings" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read observations" ON "public"."checkpoint_observations" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read race_runs" ON "public"."race_runs" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon read results" ON "public"."results" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon_insert_feedback" ON "public"."website_feedback" FOR INSERT TO "anon" WITH CHECK (true);



ALTER TABLE "public"."auth_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."auth_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_event_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkin_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkpoint_categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkpoint_observations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkpoints" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clubs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consent_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "consent_log: insert own" ON "public"."consent_log" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "consent_log: select own" ON "public"."consent_log" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."event_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_favorites" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_favorites: delete own" ON "public"."event_favorites" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "event_favorites: insert own" ON "public"."event_favorites" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "event_favorites: select own" ON "public"."event_favorites" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."event_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gate_crossings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."geocode_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."otp_throttle" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."participants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pin_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles: insert own" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "profiles: select own" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "id"));



CREATE POLICY "profiles: update own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "public_read" ON "public"."calendar_events" FOR SELECT USING (true);



ALTER TABLE "public"."race_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scraper_supersport" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service_select_feedback" ON "public"."website_feedback" FOR SELECT TO "service_role" USING (true);



CREATE POLICY "service_update_feedback" ON "public"."website_feedback" FOR UPDATE TO "service_role" USING (true);



ALTER TABLE "public"."url_suggestions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_badges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."website_feedback" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."checkpoint_observations";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."race_runs";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."results";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."check_checkin_pin"("p_event_id" "uuid", "p_pin" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."check_checkin_pin"("p_event_id" "uuid", "p_pin" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_checkin_pin"("p_event_id" "uuid", "p_pin" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_pin" "text", "p_documents" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_pin" "text", "p_documents" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_pin" "text", "p_documents" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_event_id" "uuid", "p_pin" "text", "p_documents" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_event_id" "uuid", "p_pin" "text", "p_documents" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."checkin_confirm"("p_participant_id" "uuid", "p_event_id" "uuid", "p_pin" "text", "p_documents" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."find_or_create_club"("club_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."find_or_create_club"("club_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_participant_admin"("p_event_id" "uuid", "p_pin" "text", "p_participant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_participant_admin"("p_event_id" "uuid", "p_pin" "text", "p_participant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_participant_admin"("p_event_id" "uuid", "p_pin" "text", "p_participant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_participant_for_checkin"("p_participant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_participant_for_checkin"("p_participant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_participant_for_checkin"("p_participant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_username_available"("u" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_username_available"("u" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_username_available"("u" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_username_available"("u" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_clubs"("target" "uuid", "sources" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_clubs"("target" "uuid", "sources" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_club_name"("input" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_club_name"("input" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_club_name"("input" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_calendar_event_changes"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_calendar_event_changes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_calendar_event_changes"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_clubs"("q" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_clubs"("q" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_clubs"("q" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_clubs"("q" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_participants_admin"("p_event_id" "uuid", "p_pin" "text", "p_query" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_participants_admin"("p_event_id" "uuid", "p_pin" "text", "p_query" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_participants_admin"("p_event_id" "uuid", "p_pin" "text", "p_query" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."similar_club_pairs"("threshold" real) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."similar_club_pairs"("threshold" real) TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_checkin_documents_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_checkin_documents_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_checkin_documents_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_checkins_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_checkins_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_checkins_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."verify_checkin_pin"("p_event_id" "uuid", "p_pin" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."verify_checkin_pin"("p_event_id" "uuid", "p_pin" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verify_checkin_pin"("p_event_id" "uuid", "p_pin" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";


















GRANT ALL ON TABLE "public"."admin_actions" TO "anon";
GRANT ALL ON TABLE "public"."admin_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_actions" TO "service_role";



GRANT ALL ON TABLE "public"."auth_codes" TO "anon";
GRANT ALL ON TABLE "public"."auth_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."auth_codes" TO "service_role";



GRANT ALL ON TABLE "public"."auth_sessions" TO "anon";
GRANT ALL ON TABLE "public"."auth_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."auth_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."badge_definitions" TO "anon";
GRANT ALL ON TABLE "public"."badge_definitions" TO "authenticated";
GRANT ALL ON TABLE "public"."badge_definitions" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_event_reports" TO "anon";
GRANT ALL ON TABLE "public"."calendar_event_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_event_reports" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON TABLE "public"."checkin_documents" TO "anon";
GRANT ALL ON TABLE "public"."checkin_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."checkin_documents" TO "service_role";



GRANT ALL ON TABLE "public"."checkins" TO "anon";
GRANT ALL ON TABLE "public"."checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."checkins" TO "service_role";



GRANT ALL ON TABLE "public"."checkpoint_categories" TO "anon";
GRANT ALL ON TABLE "public"."checkpoint_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."checkpoint_categories" TO "service_role";



GRANT ALL ON TABLE "public"."checkpoint_imports" TO "anon";
GRANT ALL ON TABLE "public"."checkpoint_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."checkpoint_imports" TO "service_role";



GRANT ALL ON TABLE "public"."checkpoint_observations" TO "anon";
GRANT ALL ON TABLE "public"."checkpoint_observations" TO "authenticated";
GRANT ALL ON TABLE "public"."checkpoint_observations" TO "service_role";



GRANT ALL ON TABLE "public"."checkpoint_readings" TO "anon";
GRANT ALL ON TABLE "public"."checkpoint_readings" TO "authenticated";
GRANT ALL ON TABLE "public"."checkpoint_readings" TO "service_role";



GRANT ALL ON TABLE "public"."checkpoints" TO "anon";
GRANT ALL ON TABLE "public"."checkpoints" TO "authenticated";
GRANT ALL ON TABLE "public"."checkpoints" TO "service_role";



GRANT ALL ON TABLE "public"."clubs" TO "anon";
GRANT ALL ON TABLE "public"."clubs" TO "authenticated";
GRANT ALL ON TABLE "public"."clubs" TO "service_role";



GRANT ALL ON TABLE "public"."consent_log" TO "anon";
GRANT ALL ON TABLE "public"."consent_log" TO "authenticated";
GRANT ALL ON TABLE "public"."consent_log" TO "service_role";



GRANT ALL ON TABLE "public"."dismissed_duplicates" TO "anon";
GRANT ALL ON TABLE "public"."dismissed_duplicates" TO "authenticated";
GRANT ALL ON TABLE "public"."dismissed_duplicates" TO "service_role";



GRANT ALL ON TABLE "public"."participants" TO "anon";
GRANT ALL ON TABLE "public"."participants" TO "authenticated";
GRANT ALL ON TABLE "public"."participants" TO "service_role";



GRANT ALL ON TABLE "public"."race_runs" TO "anon";
GRANT ALL ON TABLE "public"."race_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."race_runs" TO "service_role";



GRANT ALL ON TABLE "public"."results" TO "anon";
GRANT ALL ON TABLE "public"."results" TO "authenticated";
GRANT ALL ON TABLE "public"."results" TO "service_role";



GRANT ALL ON TABLE "public"."event_category_best_times" TO "anon";
GRANT ALL ON TABLE "public"."event_category_best_times" TO "authenticated";
GRANT ALL ON TABLE "public"."event_category_best_times" TO "service_role";



GRANT ALL ON TABLE "public"."event_documents" TO "anon";
GRANT ALL ON TABLE "public"."event_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."event_documents" TO "service_role";



GRANT ALL ON TABLE "public"."event_favorites" TO "anon";
GRANT ALL ON TABLE "public"."event_favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."event_favorites" TO "service_role";



GRANT ALL ON TABLE "public"."event_notifications" TO "anon";
GRANT ALL ON TABLE "public"."event_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."event_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."event_partners" TO "anon";
GRANT ALL ON TABLE "public"."event_partners" TO "authenticated";
GRANT ALL ON TABLE "public"."event_partners" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."event_results_summary" TO "anon";
GRANT ALL ON TABLE "public"."event_results_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."event_results_summary" TO "service_role";



GRANT ALL ON TABLE "public"."event_secrets" TO "anon";
GRANT ALL ON TABLE "public"."event_secrets" TO "authenticated";
GRANT ALL ON TABLE "public"."event_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."gate_crossings" TO "anon";
GRANT ALL ON TABLE "public"."gate_crossings" TO "authenticated";
GRANT ALL ON TABLE "public"."gate_crossings" TO "service_role";



GRANT ALL ON TABLE "public"."gate_events" TO "anon";
GRANT ALL ON TABLE "public"."gate_events" TO "authenticated";
GRANT ALL ON TABLE "public"."gate_events" TO "service_role";



GRANT ALL ON TABLE "public"."geocode_cache" TO "anon";
GRANT ALL ON TABLE "public"."geocode_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."geocode_cache" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."otp_throttle" TO "anon";
GRANT ALL ON TABLE "public"."otp_throttle" TO "authenticated";
GRANT ALL ON TABLE "public"."otp_throttle" TO "service_role";



GRANT ALL ON TABLE "public"."participants_public" TO "anon";
GRANT ALL ON TABLE "public"."participants_public" TO "authenticated";
GRANT ALL ON TABLE "public"."participants_public" TO "service_role";



GRANT ALL ON TABLE "public"."pin_attempts" TO "anon";
GRANT ALL ON TABLE "public"."pin_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."pin_attempts" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."profiles" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."profiles_public" TO "anon";
GRANT ALL ON TABLE "public"."profiles_public" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles_public" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_aleczas" TO "anon";
GRANT ALL ON TABLE "public"."scraper_aleczas" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_aleczas" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_all" TO "anon";
GRANT ALL ON TABLE "public"."scraper_all" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_all" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_b4sport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_b4sport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_b4sport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_bgtimesport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_bgtimesport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_bgtimesport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_biegiwpolsce" TO "anon";
GRANT ALL ON TABLE "public"."scraper_biegiwpolsce" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_biegiwpolsce" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_biegnijmy" TO "anon";
GRANT ALL ON TABLE "public"."scraper_biegnijmy" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_biegnijmy" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_czasomierzyk" TO "anon";
GRANT ALL ON TABLE "public"."scraper_czasomierzyk" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_czasomierzyk" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_datasport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_datasport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_datasport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_dostartu" TO "anon";
GRANT ALL ON TABLE "public"."scraper_dostartu" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_dostartu" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_egepard" TO "anon";
GRANT ALL ON TABLE "public"."scraper_egepard" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_egepard" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_elektronicznezapisy" TO "anon";
GRANT ALL ON TABLE "public"."scraper_elektronicznezapisy" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_elektronicznezapisy" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_foxter" TO "anon";
GRANT ALL ON TABLE "public"."scraper_foxter" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_foxter" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_herkules" TO "anon";
GRANT ALL ON TABLE "public"."scraper_herkules" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_herkules" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_inessport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_inessport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_inessport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_kepasport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_kepasport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_kepasport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_lumisport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_lumisport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_lumisport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_maratonczykpomiarczasu" TO "anon";
GRANT ALL ON TABLE "public"."scraper_maratonczykpomiarczasu" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_maratonczykpomiarczasu" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_maratonypolskie" TO "anon";
GRANT ALL ON TABLE "public"."scraper_maratonypolskie" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_maratonypolskie" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_pifsport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_pifsport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_pifsport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_plustiming" TO "anon";
GRANT ALL ON TABLE "public"."scraper_plustiming" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_plustiming" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_pomiaryczasu" TO "anon";
GRANT ALL ON TABLE "public"."scraper_pomiaryczasu" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_pomiaryczasu" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_protiming24" TO "anon";
GRANT ALL ON TABLE "public"."scraper_protiming24" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_protiming24" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_raatiming" TO "anon";
GRANT ALL ON TABLE "public"."scraper_raatiming" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_raatiming" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_rajsportactive" TO "anon";
GRANT ALL ON TABLE "public"."scraper_rajsportactive" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_rajsportactive" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_sporttime" TO "anon";
GRANT ALL ON TABLE "public"."scraper_sporttime" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_sporttime" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_superczas" TO "anon";
GRANT ALL ON TABLE "public"."scraper_superczas" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_superczas" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_supersport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_supersport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_supersport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_timekeeper" TO "anon";
GRANT ALL ON TABLE "public"."scraper_timekeeper" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_timekeeper" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_timesport" TO "anon";
GRANT ALL ON TABLE "public"."scraper_timesport" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_timesport" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_timing4u" TO "anon";
GRANT ALL ON TABLE "public"."scraper_timing4u" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_timing4u" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_wbtiming" TO "anon";
GRANT ALL ON TABLE "public"."scraper_wbtiming" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_wbtiming" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_zapisyonline" TO "anon";
GRANT ALL ON TABLE "public"."scraper_zapisyonline" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_zapisyonline" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_zapisyvaldano" TO "anon";
GRANT ALL ON TABLE "public"."scraper_zapisyvaldano" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_zapisyvaldano" TO "service_role";



GRANT ALL ON TABLE "public"."scraper_zmierzymyczas" TO "anon";
GRANT ALL ON TABLE "public"."scraper_zmierzymyczas" TO "authenticated";
GRANT ALL ON TABLE "public"."scraper_zmierzymyczas" TO "service_role";



GRANT ALL ON TABLE "public"."url_suggestions" TO "anon";
GRANT ALL ON TABLE "public"."url_suggestions" TO "authenticated";
GRANT ALL ON TABLE "public"."url_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."user_badges" TO "anon";
GRANT ALL ON TABLE "public"."user_badges" TO "authenticated";
GRANT ALL ON TABLE "public"."user_badges" TO "service_role";



GRANT ALL ON TABLE "public"."website_feedback" TO "anon";
GRANT ALL ON TABLE "public"."website_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."website_feedback" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

drop policy "Anyone can read badges" on "public"."user_badges";

revoke delete on table "public"."profiles" from "anon";

revoke insert on table "public"."profiles" from "anon";

revoke references on table "public"."profiles" from "anon";

revoke select on table "public"."profiles" from "anon";

revoke trigger on table "public"."profiles" from "anon";

revoke truncate on table "public"."profiles" from "anon";

revoke update on table "public"."profiles" from "anon";

revoke delete on table "public"."profiles" from "authenticated";

revoke insert on table "public"."profiles" from "authenticated";

revoke references on table "public"."profiles" from "authenticated";

revoke trigger on table "public"."profiles" from "authenticated";

revoke truncate on table "public"."profiles" from "authenticated";

revoke update on table "public"."profiles" from "authenticated";


  create policy "Anyone can read badges"
  on "public"."user_badges"
  as permissive
  for select
  to anon, authenticated
using (true);



  create policy "Public read access for partner logos"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'partner-logos'::text));



  create policy "Service role delete for partner logos"
  on "storage"."objects"
  as permissive
  for delete
  to public
using ((bucket_id = 'partner-logos'::text));



  create policy "Service role upload for partner logos"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check ((bucket_id = 'partner-logos'::text));



