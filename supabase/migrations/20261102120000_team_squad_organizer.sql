-- Plan 6, task 4: the organizer edits a team's squad (Plan 5 ruling 11: the captain deleted the
-- account, or asked the club to). team_squad_edit gains p_as_organizer, which skips the captain
-- check; everything else is Plan 5's function unchanged (20261101120000_team_squad_edit.sql):
-- the locks, squad_closed at closes_at, team_full, captain_fixed.
--
-- CREATE OR REPLACE with an added parameter would create a second function beside the old one,
-- so the 4-argument version is dropped first. A captain's call with four named arguments still
-- resolves to this one through the default.
--
-- An organizer may not bring in a child (minor_by_organizer): team_squad_insert makes the actor the
-- child's guardian, and the organizer is nobody's guardian.

DROP FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb);

CREATE FUNCTION public.team_squad_edit(p_team_id uuid, p_actor_profile_id uuid, p_op jsonb, p_meta jsonb,
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

  SELECT count(*), max(r.team_leg) INTO v_count, v_max
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
                                      p_actor_profile_id, p_meta);
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

  UPDATE public.registrations SET status = 'cancelled' WHERE id = v_old.id;
  IF v_old.participant_id IS NOT NULL THEN
    UPDATE public.participants SET removed_at = now(), updated_at = now() WHERE id = v_old.participant_id;
  END IF;
  v_new := public.team_squad_insert(v_rs, v_cap, p_op->'person', v_old.team_leg, p_actor_profile_id, p_meta);

  RETURN jsonb_build_object(
    'added', jsonb_build_array(jsonb_build_object('id', v_new, 'role', p_op#>>'{person,role}')),
    'removed', jsonb_build_array(jsonb_build_object('id', v_old.id, 'email', v_old.email, 'firstName', v_old.first_name)));
END $$;
REVOKE EXECUTE ON FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb, boolean) TO service_role;
