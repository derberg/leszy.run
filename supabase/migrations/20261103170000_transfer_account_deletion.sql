-- Plan 7, task 10 (carry T10 a): what delete-my-account does to package transfers.
--
--   forget_transfer_parties(p_registration_ids, p_profile_id, p_email)
--     As SENDER: an open invite of an entry the deletion anonymises (p_registration_ids), or one
--       the person sent (from_profile_id), is cancelled. Its link would otherwise hand an
--       anonymised entry to whoever holds it.
--     As RECIPIENT: the open invites to p_email are cancelled first, because a pending invite must
--       keep an address (transfers_pending_has_address); then every other transfer addressed to
--       p_email (accepted, cancelled, expired, either kind) loses to_email. The rows stay: they
--       are the record of where a package went, and nothing in them names the person any more.
--     → { cancelledSent, cancelledReceived, addressCleared, sentInvites }. sentInvites lists the
--       invites cancelled as sender, [{ id, toEmail, eventName }], so delete-my-account can tell
--       each invited person (V-88) without naming the sender.
--
-- Lock order: registrations, then transfers, the suffix that cancel_transfer and accept_transfer
-- take, so an accept racing the deletion either lands first (the invite is accepted, and its
-- address is cleared like any other) or finds the invite cancelled (gone). The registrations of the
-- invites it may cancel are locked in id order. An invite created between the statements keeps its
-- address; the address is retired right after (deleted_email_hashes), so no login can take it.
--
-- SECURITY DEFINER, search_path '', service_role only.

CREATE FUNCTION public.forget_transfer_parties(p_registration_ids uuid[], p_profile_id uuid, p_email text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_email     text := nullif(lower(btrim(p_email)), '');
  v_ids       uuid[] := coalesce(p_registration_ids, '{}');
  v_regs      uuid[];
  v_sent      integer := 0;
  v_received  integer := 0;
  v_cleared   integer := 0;
  v_invites   jsonb;
BEGIN
  SELECT coalesce(array_agg(DISTINCT t.registration_id ORDER BY t.registration_id), '{}') INTO v_regs
    FROM public.transfers t
   WHERE t.status = 'pending'
     AND (t.registration_id = ANY (v_ids)
          OR (p_profile_id IS NOT NULL AND t.from_profile_id = p_profile_id)
          OR (v_email IS NOT NULL AND t.to_email = v_email));
  PERFORM 1 FROM public.registrations WHERE id = ANY (v_regs) ORDER BY id FOR UPDATE;

  WITH c AS (
    UPDATE public.transfers SET status = 'cancelled', cancelled_at = now()
     WHERE status = 'pending'
       AND (registration_id = ANY (v_ids) OR (p_profile_id IS NOT NULL AND from_profile_id = p_profile_id))
    RETURNING id, to_email, event_id
  )
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'toEmail', c.to_email, 'eventName', rs.name)
                                      ORDER BY c.id) FILTER (WHERE c.to_email IS NOT NULL), '[]'::jsonb)
    INTO v_sent, v_invites
    FROM c LEFT JOIN public.registration_settings rs ON rs.event_id = c.event_id;

  IF v_email IS NOT NULL THEN
    UPDATE public.transfers SET status = 'cancelled', cancelled_at = now()
     WHERE status = 'pending' AND to_email = v_email;
    GET DIAGNOSTICS v_received = ROW_COUNT;
    UPDATE public.transfers SET to_email = NULL
     WHERE to_email = v_email AND status <> 'pending';
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('cancelledSent', v_sent, 'cancelledReceived', v_received, 'addressCleared', v_cleared,
                            'sentInvites', v_invites);
END $$;
REVOKE EXECUTE ON FUNCTION public.forget_transfer_parties(uuid[], uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forget_transfer_parties(uuid[], uuid, text) TO service_role;
