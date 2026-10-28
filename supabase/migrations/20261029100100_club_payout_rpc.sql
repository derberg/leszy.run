-- One transaction for a payout change: the details row and its history row
-- either both land or neither does. Called by update-club-payout only.
CREATE OR REPLACE FUNCTION public.save_club_payout(
  p_club_id uuid, p_actor uuid, p_club_name text, p_new jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old jsonb;
BEGIN
  SELECT to_jsonb(d) - 'club_id' - 'updated_by' - 'updated_at' INTO v_old
    FROM public.club_payout_details d
   WHERE d.club_id = p_club_id
   FOR UPDATE;

  INSERT INTO public.club_payout_details AS t (club_id, legal_name, nip, krs, iban, address, updated_by, updated_at)
  VALUES (p_club_id, p_new->>'legal_name', p_new->>'nip', p_new->>'krs', p_new->>'iban', p_new->>'address', p_actor, now())
  ON CONFLICT (club_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, nip = EXCLUDED.nip, krs = EXCLUDED.krs,
    iban = EXCLUDED.iban, address = EXCLUDED.address,
    updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.club_payout_history (club_id, club_name, changed_by, old, new)
  VALUES (p_club_id, p_club_name, p_actor, v_old, p_new);

  RETURN jsonb_build_object('old', v_old, 'new', p_new);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_club_payout(uuid, uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_club_payout(uuid, uuid, text, jsonb) TO service_role;
