-- Plan 5, task 4: the captain edits the squad until registration closes.
--
-- team_squad_edit(team, actor, op, meta) → { added: [{ id, role }], removed: [{ id, email|null, firstName }] }
--   reorder  { op, legs: [registrationId…] }             a permutation of the live members
--   swap     { op, registrationId, person }              never the captain (Plan 7's transfer)
--   add      { op, person, leg? }                        up to team_max. With leg order on the new
--                                                        member runs last: a leg sent is not read
--
-- A member change never touches a slot, on a pending team or a confirmed one (P3-R15), and never
-- the fee: the one entry line stays on the captain and members carry 0 (ruling 4).
--
-- Lock order: the team's order row, the competition FOR SHARE, the settings FOR SHARE, the team, the
-- live members. confirm_order, expire_orders and cancel_order take the order first, so a squad edit
-- on a team with an order cannot invert against them, and anything that moves closes_at or the
-- squad size waits for the competition lock. closes_at is read with clock_timestamp() after the
-- settings lock, because a publish this call waited for may have moved it, and now() is the time
-- the transaction began.
--
-- A swap cancels the old row before it inserts the new one: the new row takes its leg, and the
-- partial leg index would refuse both live. Any refusal raises, so the cancel rolls back with it.
-- consent_requests stay: accept_consent_request refuses a cancelled registration with 'gone'.
--
-- reorder: an UPDATE of a unique column checks the index row by row, so swapping two legs in one
-- statement trips it. Every leg first moves above every value in use, then to its place. The shift
-- is the larger of the highest leg and the squad size: each shifted leg passes both, so step one
-- collides with nothing unshifted and step two with nothing shifted. Shifting up, not negating,
-- because team_leg has CHECK (team_leg >= 1).
--
-- The added leg is the highest leg + 1. Squads have no gaps today, so that is n + 1. It stays right
-- if Plan 6's organizer removal leaves one, where n + 1 could land on a leg in use.
--
-- A child's acceptances are the captain's as guardian, so an edit bringing in a child must carry
-- the consents the captain was shown, as create_team_registration does. An adult accepts for
-- themself later, and the edge function issues their request (Task 5).

-- One new member: the row, its acceptances, its team and leg, and the participant on a confirmed
-- team. The team's order and status come from the captain's row. Internal, like
-- registration_group_insert: it runs as its caller.
CREATE FUNCTION public.team_squad_insert(p_rs public.registration_settings, p_captain public.registrations,
                                         p_person jsonb, p_leg integer, p_actor uuid, p_meta jsonb)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_role  text := CASE WHEN jsonb_typeof(p_person) = 'object' THEN p_person->>'role' END;
  v_email text;
  v_name  text;
  v_ip    inet;
  v_ua    text := left(nullif(p_meta->>'userAgent', ''), 500);
  v_sent  uuid[];
  v_have  uuid[];
  v_reg   uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('adult', 'minor')
     OR nullif(btrim(p_person->>'firstName'), '') IS NULL OR nullif(btrim(p_person->>'lastName'), '') IS NULL
     OR (v_role = 'adult' AND nullif(btrim(p_person->>'email'), '') IS NULL)
     OR (v_role = 'minor' AND nullif(p_person->>'birthDate', '') IS NULL) THEN
    RAISE EXCEPTION 'invalid_people';
  END IF;

  IF v_role = 'minor' THEN
    IF jsonb_typeof(coalesce(p_meta->'consentIds', '[]'::jsonb)) <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(e)
                   WHERE jsonb_typeof(e) <> 'string'
                      OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
    SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid), '{}') INTO v_sent
      FROM jsonb_array_elements_text(coalesce(p_meta->'consentIds', '[]'::jsonb)) AS t(x);
    SELECT coalesce(array_agg(ec.id ORDER BY ec.id), '{}') INTO v_have
      FROM public.event_consents ec WHERE ec.event_id = p_rs.event_id;
    IF v_sent IS DISTINCT FROM v_have THEN
      RAISE EXCEPTION 'consents_changed';
    END IF;
  END IF;

  SELECT lower(btrim(p.email)) INTO v_email FROM public.profiles p WHERE p.id = p_actor;
  v_name := coalesce(nullif(btrim(p_meta->>'buyerName'), ''),
                     btrim(concat_ws(' ', p_captain.first_name, p_captain.last_name)));
  BEGIN
    v_ip := nullif(p_meta->>'ip', '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  BEGIN
    v_reg := public.registration_group_insert(
      p_rs, p_person || jsonb_build_object('categoryId', p_captain.category_id), 0, p_actor, v_email, v_name,
      p_captain.order_id, p_captain.status, 0, v_ip, v_ua);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'duplicate:%' THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
    RAISE;
  END;

  UPDATE public.registrations SET team_id = p_captain.team_id, team_leg = p_leg WHERE id = v_reg;
  IF p_captain.status = 'confirmed' THEN
    PERFORM public.insert_registration_participant(v_reg);
  END IF;
  RETURN v_reg;
END $$;
REVOKE EXECUTE ON FUNCTION public.team_squad_insert(public.registration_settings, public.registrations, jsonb, integer, uuid, jsonb)
  FROM public, anon, authenticated, service_role;

CREATE FUNCTION public.team_squad_edit(p_team_id uuid, p_actor_profile_id uuid, p_op jsonb, p_meta jsonb)
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

  IF p_actor_profile_id IS NULL OR v_cap.profile_id IS DISTINCT FROM p_actor_profile_id THEN
    RAISE EXCEPTION 'not_captain';
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
    IF NOT v_comp.leg_order_enabled THEN
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
REVOKE EXECUTE ON FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_squad_edit(uuid, uuid, jsonb, jsonb) TO service_role;
