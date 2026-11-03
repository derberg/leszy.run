-- Fix round on 20261112100000_team_minor_parent_consent.sql (a team child whose parent is not the
-- captain).
--
-- 1. The 30-day contact purge nulled guardian_name and guardian_email of every past child entry. A
--    child whose named parent never accepted, or whose consent was signed on paper, also has no
--    guardian_profile_id, so nothing on the row said „child” any more: registrationRole and the SQL
--    rule (guardian_name / guardian_profile_id / guardian_removed_at) read it as an adult, in the
--    organizer panel, the CSV, the captain's pages and the exports. The purge now stamps
--    guardian_removed_at on such a row, as delete-my-account does when a guardian leaves, so the
--    marker outlives the contact. The birth date was not used instead: it would turn a child into
--    an adult on their 18th birthday, after the race they ran as a child.
-- 2. team_squad_edit's `removed` carries `guardianEmail` for such a child, read before the swap
--    clears the row, so team-squad tells the parent the child left the squad.
--
-- purge_registration_contact_data is recreated from 20261103190000, team_squad_edit from
-- 20261102120000, each changed only where marked. CREATE OR REPLACE keeps the grants; the REVOKE /
-- GRANT after each restates them.

-- ---------------------------------------------------------------- purge_registration_contact_data (from 20261103190000)

CREATE OR REPLACE FUNCTION public.purge_registration_contact_data() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_cutoff date := (now() AT TIME ZONE 'Europe/Warsaw')::date - 30;
  v_regs   integer;
  v_parts  integer;
  v_teams  integer;
  v_trans  integer;
BEGIN
  UPDATE public.registrations r
     SET phone = NULL, ice_name = NULL, ice_phone = NULL, guardian_name = NULL, guardian_email = NULL,
         -- Changed here: a child whose guardian has no account here (a parent the captain named who
         -- never accepted, or signed on paper) keeps a marker that it is a child, as a deleted
         -- guardian's child does: registrationRole and the SQL rules read guardian_removed_at.
         guardian_removed_at = CASE WHEN r.guardian_profile_id IS NULL
                                     AND (r.guardian_name IS NOT NULL OR r.guardian_email IS NOT NULL)
                                    THEN coalesce(r.guardian_removed_at, now())
                                    ELSE r.guardian_removed_at END
    FROM public.registration_settings rs
   WHERE rs.event_id = r.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND (r.phone IS NOT NULL OR r.ice_name IS NOT NULL OR r.ice_phone IS NOT NULL
          OR r.guardian_name IS NOT NULL OR r.guardian_email IS NOT NULL);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.participants p
     SET phone = NULL
    FROM public.registrations r
    JOIN public.registration_settings rs ON rs.event_id = r.event_id
   WHERE p.registration_id = r.id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND p.phone IS NOT NULL;
  GET DIAGNOSTICS v_parts = ROW_COUNT;

  SELECT coalesce(sum(public.neutralise_team_name(t.id)), 0)::integer INTO v_teams
    FROM public.teams t
    JOIN public.registration_settings rs ON rs.event_id = t.event_id
   WHERE rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff;

  -- Plan 7 (final review I-3): the address an invite was sent to. An open invite of a past race
  -- cannot be accepted any more; it is expired first, because a pending invite must keep an address
  -- (transfers_pending_has_address). Then every transfer of the event loses to_email; the rows stay
  -- as the record of where a package went.
  UPDATE public.transfers t
     SET status = 'expired'
    FROM public.registration_settings rs
   WHERE rs.event_id = t.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND t.status = 'pending';
  UPDATE public.transfers t
     SET to_email = NULL
    FROM public.registration_settings rs
   WHERE rs.event_id = t.event_id
     AND rs.event_date IS NOT NULL
     AND rs.event_date <= v_cutoff
     AND t.to_email IS NOT NULL;
  GET DIAGNOSTICS v_trans = ROW_COUNT;

  RETURN v_regs + v_parts + v_teams + v_trans;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_registration_contact_data() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_registration_contact_data() TO service_role;

-- ---------------------------------------------------------------- team_squad_edit (from 20261102120000)

CREATE OR REPLACE FUNCTION public.team_squad_edit(p_team_id uuid, p_actor_profile_id uuid, p_op jsonb, p_meta jsonb,
                                       p_as_organizer boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  c_live  constant text[] := ARRAY['pending_payment', 'confirmed'];
  v_op    text := CASE WHEN jsonb_typeof(p_op) = 'object' THEN p_op->>'op' END;
  v_team  public.teams%ROWTYPE;
  v_comp  public.competitions%ROWTYPE;
  v_rs    public.registration_settings%ROWTYPE;
  v_cap   public.registrations%ROWTYPE;
  v_old   public.registrations%ROWTYPE;
  v_order uuid;
  v_count integer;
  v_max   integer;
  v_pos   integer;
  v_gone  constant text := 'Usunięte zgłoszenie';
  v_id    uuid;
  v_new   uuid;
BEGIN
  IF v_op IS NULL OR v_op NOT IN ('reorder', 'swap', 'add') THEN
    RAISE EXCEPTION 'invalid_op';
  END IF;

  -- Found without a lock, for the order id alone: the team is read again once locked.
  SELECT * INTO v_team FROM public.teams WHERE id = p_team_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT r.order_id INTO v_order FROM public.registrations r WHERE r.id = v_team.captain_registration_id;
  IF v_order IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = v_order FOR UPDATE;
  END IF;
  SELECT * INTO v_comp FROM public.competitions WHERE category_id = v_team.category_id FOR SHARE;
  SELECT * INTO v_rs FROM public.registration_settings WHERE event_id = v_team.event_id FOR SHARE;
  SELECT * INTO v_team FROM public.teams WHERE id = p_team_id FOR UPDATE;
  PERFORM 1 FROM public.registrations WHERE team_id = p_team_id AND status = ANY (c_live) ORDER BY id FOR UPDATE;
  SELECT * INTO v_cap FROM public.registrations WHERE id = v_team.captain_registration_id;

  -- The organizer (Plan 6) is not the captain: the edge function checked the club role. The actor
  -- is still required, it becomes registered_by_profile_id of a member brought in.
  IF p_actor_profile_id IS NULL
     OR (p_as_organizer IS NOT TRUE AND v_cap.profile_id IS DISTINCT FROM p_actor_profile_id) THEN
    RAISE EXCEPTION 'not_captain';
  END IF;
  -- A child's guardian is the person who registers them, here the organizer: refused. The captain,
  -- as guardian, brings a child in.
  IF p_as_organizer IS TRUE AND v_op IN ('swap', 'add') AND p_op#>>'{person,role}' = 'minor' THEN
    RAISE EXCEPTION 'minor_by_organizer';
  END IF;
  IF v_team.released_at IS NOT NULL OR v_cap.status <> ALL (c_live) THEN
    RAISE EXCEPTION 'team_inactive';
  END IF;
  IF v_rs.state <> 'published' OR v_rs.closes_at IS NULL OR clock_timestamp() >= v_rs.closes_at THEN
    RAISE EXCEPTION 'squad_closed';
  END IF;

  SELECT count(*), max(r.team_leg), max(r.team_position) INTO v_count, v_max, v_pos
    FROM public.registrations r WHERE r.team_id = p_team_id AND r.status = ANY (c_live);

  IF v_op = 'reorder' THEN
    IF v_comp.leg_order_enabled IS NOT TRUE THEN
      RAISE EXCEPTION 'leg_order_off';
    END IF;
    IF jsonb_typeof(p_op->'legs') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid_legs';
    END IF;
    IF (SELECT array_agg(l.id ORDER BY l.id) FROM jsonb_array_elements_text(p_op->'legs') AS l(id))
       IS DISTINCT FROM
       (SELECT array_agg(r.id::text ORDER BY r.id::text) FROM public.registrations r
         WHERE r.team_id = p_team_id AND r.status = ANY (c_live)) THEN
      RAISE EXCEPTION 'invalid_legs';
    END IF;
    UPDATE public.registrations
       SET team_leg = team_leg + greatest(coalesce(v_max, 0), v_count)
     WHERE team_id = p_team_id AND status = ANY (c_live);
    UPDATE public.registrations r SET team_leg = l.leg
      FROM jsonb_array_elements_text(p_op->'legs') WITH ORDINALITY AS l(id, leg)
     WHERE r.id = l.id::uuid;
    RETURN jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb);
  END IF;

  IF v_op = 'add' THEN
    IF (v_count < v_comp.team_max) IS NOT TRUE THEN
      RAISE EXCEPTION 'team_full';
    END IF;
    v_new := public.team_squad_insert(v_rs, v_cap, p_op->'person',
                                      CASE WHEN v_comp.leg_order_enabled THEN coalesce(v_max, 0) + 1 END,
                                      coalesce(v_pos, 0) + 1, p_actor_profile_id, p_meta);
    RETURN jsonb_build_object(
      'added', jsonb_build_array(jsonb_build_object('id', v_new, 'role', p_op#>>'{person,role}')),
      'removed', '[]'::jsonb);
  END IF;

  -- swap
  IF coalesce(p_op->>'registrationId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'not_member';
  END IF;
  v_id := (p_op->>'registrationId')::uuid;
  IF v_id = v_team.captain_registration_id THEN
    RAISE EXCEPTION 'captain_fixed';
  END IF;
  SELECT * INTO v_old FROM public.registrations
   WHERE id = v_id AND team_id = p_team_id AND status = ANY (c_live);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  UPDATE public.registrations
     SET status = 'cancelled',
         first_name = v_gone, last_name = v_gone, profile_id = NULL,
         email = NULL, phone = NULL, birth_date = NULL, city = NULL, club = NULL,
         ice_name = NULL, ice_phone = NULL, nationality = NULL,
         guardian_profile_id = NULL, guardian_name = NULL, guardian_email = NULL
   WHERE id = v_old.id;
  UPDATE public.consent_acceptances SET ip = NULL, user_agent = NULL
   WHERE registration_id = v_old.id AND (ip IS NOT NULL OR user_agent IS NOT NULL);
  IF v_old.participant_id IS NOT NULL THEN
    UPDATE public.participants
       SET removed_at = now(), updated_at = now(),
           first_name = v_gone, last_name = v_gone, email = NULL, phone = NULL, birth_date = NULL, club = NULL
     WHERE id = v_old.participant_id;
  END IF;
  v_new := public.team_squad_insert(v_rs, v_cap, p_op->'person', v_old.team_leg, v_old.team_position,
                                    p_actor_profile_id, p_meta);

  RETURN jsonb_build_object(
    'added', jsonb_build_array(jsonb_build_object('id', v_new, 'role', p_op#>>'{person,role}')),
    -- Changed here: a child whose parent the captain named is told of through that parent, whose
    -- address goes only here, read before the row was cleared.
    'removed', jsonb_build_array(jsonb_build_object('id', v_old.id, 'email', v_old.email, 'firstName', v_old.first_name,
      'guardianEmail', CASE WHEN v_old.email IS NULL AND v_old.guardian_profile_id IS DISTINCT FROM v_old.registered_by_profile_id
                            THEN v_old.guardian_email END)));
END $$;
REVOKE EXECUTE ON FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb, boolean) TO service_role;
