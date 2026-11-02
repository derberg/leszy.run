-- Club payout details can be saved in parts. The name, NIP and address name
-- the Organizer (agreement §1 ust. 2) and are what a paid event needs to
-- publish; the account number is needed only for the payout itself (§7), so a
-- club may publish first and give the account later. A row with the name, NIP
-- and address is "identity complete" (organizerIdentityReady() in
-- _shared/registration/eventPayout.js); the same three columns are checked here.

ALTER TABLE public.club_payout_details
  ALTER COLUMN legal_name DROP NOT NULL,
  ALTER COLUMN nip DROP NOT NULL,
  ALTER COLUMN iban DROP NOT NULL,
  ALTER COLUMN address DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.save_event_payout(
  p_event_id uuid, p_actor uuid, p_mode text,
  p_recipient text, p_tax_id text, p_iban text, p_title text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_club   uuid;
  v_state  text;
  v_live   text;
  v_staged text;
  v_old    jsonb;
  v_new    jsonb;
BEGIN
  SELECT rs.club_id, rs.state, rs.pricing_mode, pc.payload->'competitions'->>'pricing_mode'
    INTO v_club, v_state, v_live, v_staged
    FROM public.registration_settings rs
    LEFT JOIN public.registration_pending_changes pc ON pc.event_id = rs.event_id
   WHERE rs.event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = v_club AND m.user_id = p_actor
                    AND m.status = 'active' AND m.role = 'owner')
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.registration_enabled) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  -- A published event that collects money (live or staged pricing) never
  -- switches to a club account whose Organizer is not named (name, NIP,
  -- address): runners would pay on behalf of nobody. The account number may
  -- still be missing, as it may at publish. A draft may: its checklist blocks.
  IF p_mode = 'club' AND v_state <> 'draft'
     AND (coalesce(v_live, 'free') <> 'free' OR coalesce(v_staged, 'free') <> 'free')
     AND NOT EXISTS (SELECT 1 FROM public.club_payout_details d
                      WHERE d.club_id = v_club AND nullif(btrim(d.legal_name), '') IS NOT NULL
                        AND d.nip IS NOT NULL AND nullif(btrim(d.address), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'payout_not_ready';
  END IF;
  -- The club account keeps no event-level details; another account needs all
  -- three identifying fields. Only the format is checked here: the NIP and
  -- IBAN checksums are update-event-payout's (payoutValidation.js), and the
  -- checklist re-checks them on read (customPayoutReady).
  IF p_mode = 'club' THEN
    v_new := jsonb_build_object('payout_mode', 'club', 'payout_recipient', NULL, 'payout_tax_id', NULL,
                                'payout_iban', NULL, 'payout_title', NULL);
  ELSIF p_mode = 'custom'
        AND nullif(btrim(p_recipient), '') IS NOT NULL
        AND p_tax_id ~ '^[0-9]{10}$'
        AND p_iban ~ '^PL[0-9]{26}$' THEN
    v_new := jsonb_build_object('payout_mode', 'custom', 'payout_recipient', btrim(p_recipient), 'payout_tax_id', p_tax_id,
                                'payout_iban', p_iban, 'payout_title', nullif(btrim(p_title), ''));
  ELSE
    RAISE EXCEPTION 'invalid_payout';
  END IF;

  -- Serialise saves per event: FOR UPDATE locks nothing before the first save.
  PERFORM pg_advisory_xact_lock(hashtext('event_payout:' || p_event_id::text));

  SELECT to_jsonb(d) - 'event_id' - 'updated_by' - 'updated_at' INTO v_old
    FROM public.event_payout_details d
   WHERE d.event_id = p_event_id
   FOR UPDATE;

  -- Saved again unchanged: nothing to record.
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN jsonb_build_object('old', v_old, 'new', v_new, 'clubId', v_club, 'unchanged', true);
  END IF;

  INSERT INTO public.event_payout_details AS t
         (event_id, payout_mode, payout_recipient, payout_tax_id, payout_iban, payout_title, updated_by, updated_at)
  VALUES (p_event_id, v_new->>'payout_mode', v_new->>'payout_recipient', v_new->>'payout_tax_id',
          v_new->>'payout_iban', v_new->>'payout_title', p_actor, now())
  ON CONFLICT (event_id) DO UPDATE SET
    payout_mode = EXCLUDED.payout_mode, payout_recipient = EXCLUDED.payout_recipient,
    payout_tax_id = EXCLUDED.payout_tax_id, payout_iban = EXCLUDED.payout_iban,
    payout_title = EXCLUDED.payout_title, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.event_payout_history (event_id, changed_by, old, new)
  VALUES (p_event_id, p_actor, v_old, v_new);

  RETURN jsonb_build_object('old', v_old, 'new', v_new, 'clubId', v_club);
END $$;
REVOKE EXECUTE ON FUNCTION public.save_event_payout(uuid, uuid, text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_event_payout(uuid, uuid, text, text, text, text, text) TO service_role;
