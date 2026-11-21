-- A registered runner's participant gets an emoji.
--
-- insert_registration_participant (the participant bridge, 20261030110000) never set
-- participants.emoji, so every runner from online registration reached the timing host
-- with none, and the admin table showed its 🏃 placeholder for all of them. The host
-- draws an emoji only for participants it creates itself (backend/src/lib/emoji.js);
-- one it pulls from Supabase keeps what Supabase holds.
--
-- The emoji is drawn here, in Supabase, so every host and the public pages show the
-- same one. A runner with an account (the registration's profile_id) gets the account's
-- avatar_emoji; anyone else (an added adult, a child, a team member) gets a random one
-- from the same pool, preferring one nobody in the event has yet.

CREATE OR REPLACE FUNCTION public.registration_participant_emoji(p_event_id uuid, p_profile_id uuid)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_emoji text;
  v_try   int := 0;
BEGIN
  IF p_profile_id IS NOT NULL THEN
    SELECT avatar_emoji INTO v_emoji FROM public.profiles WHERE id = p_profile_id;
    IF v_emoji IS NOT NULL THEN
      RETURN v_emoji;
    END IF;
  END IF;
  -- Up to 20 draws for one not used in the event, as pickEmoji() on the host does;
  -- then the last draw, used or not.
  LOOP
    v_emoji := public.random_avatar_emoji();
    v_try := v_try + 1;
    EXIT WHEN v_try >= 20
      OR NOT EXISTS (SELECT 1 FROM public.participants WHERE event_id = p_event_id AND emoji = v_emoji);
  END LOOP;
  RETURN v_emoji;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_participant_emoji(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registration_participant_emoji(uuid, uuid) TO service_role;

-- Same body as 20261030110000_registration_order_rpcs.sql, plus emoji.
CREATE OR REPLACE FUNCTION public.insert_registration_participant(p_registration_id uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  r      public.registrations%ROWTYPE;
  v_part uuid;
BEGIN
  SELECT * INTO r FROM public.registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF r.participant_id IS NOT NULL THEN
    RETURN r.participant_id;
  END IF;
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_confirmed';
  END IF;

  INSERT INTO public.participants (
    event_id, category_id, first_name, last_name, email, gender, birth_date, club, phone,
    emoji, registration_id, updated_at)
  VALUES (
    r.event_id, r.category_id, r.first_name, r.last_name, r.email, r.gender, r.birth_date, r.club, r.phone,
    public.registration_participant_emoji(r.event_id, r.profile_id), r.id, now())
  RETURNING id INTO v_part;

  UPDATE public.registrations SET participant_id = v_part WHERE id = r.id;
  RETURN v_part;
END $$;
REVOKE EXECUTE ON FUNCTION public.insert_registration_participant(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_registration_participant(uuid) TO service_role;

-- Registration participants created before this migration. One row at a time, so each
-- draw sees the emojis already given in its event. configSync re-reads every row on each
-- poll, so a clean host row picks the emoji up within 30 s; a host row with a pending
-- local edit pushes its NULL back, and that runner gets one from the host's own
-- regenerate button.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT pa.id, pa.event_id, rg.profile_id
    FROM public.participants pa
    LEFT JOIN public.registrations rg ON rg.id = pa.registration_id
    WHERE pa.registration_id IS NOT NULL AND pa.emoji IS NULL
    ORDER BY pa.event_id, pa.created_at, pa.id
  LOOP
    UPDATE public.participants
      SET emoji = public.registration_participant_emoji(p.event_id, p.profile_id), updated_at = now()
      WHERE id = p.id;
  END LOOP;
END $$;
