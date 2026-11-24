-- Competition change, review fix: who pays a surcharge of an entry that came by a transfer.
-- registration_surcharge_buyer (newest body: 20261124110000_competition_change_rpc.sql) billed the
-- entry's order's buyer. A transferred-in registration keeps that order (registrations.order_id is
-- never repointed), so after a transfer the original payer was asked to pay for the new holder's
-- change, and after an organizer transfer was told who holds the package now (ruling N-1). Such a
-- registration now skips the original buyer and goes to the holder branch: the guardian for a
-- child, else the holder's account, else the registration's own e-mail. Only that is changed.
-- CREATE OR REPLACE keeps the grants (none: internal).

CREATE OR REPLACE FUNCTION public.registration_surcharge_buyer(p_registration_id uuid)
  RETURNS TABLE (profile_id uuid, email text, name text)
  LANGUAGE plpgsql
  STABLE
  SET search_path = ''
AS $$
DECLARE
  r       public.registrations%ROWTYPE;
  o       public.orders%ROWTYPE;
  v_email text;
  v_child boolean;
BEGIN
  SELECT * INTO r FROM public.registrations x WHERE x.id = p_registration_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Changed here: an entry that came by a transfer (runner or organizer) keeps the original
  -- order, whose buyer chose neither the new holder nor this change (ruling N-1): the holder pays.
  IF r.order_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.transfers t WHERE t.new_registration_id = r.id AND t.status = 'accepted') THEN
    SELECT * INTO o FROM public.orders x WHERE x.id = r.order_id;
    IF o.buyer_profile_id IS NOT NULL THEN
      SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = o.buyer_profile_id AND p.deleted_at IS NULL;
      IF FOUND AND coalesce(o.buyer_email, v_email) IS NOT NULL THEN
        profile_id := o.buyer_profile_id;
        email := coalesce(o.buyer_email, v_email);
        name := o.buyer_name;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  v_child := r.email IS NULL;
  v_email := NULL;
  IF v_child AND r.guardian_profile_id IS NOT NULL THEN
    SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = r.guardian_profile_id AND p.deleted_at IS NULL;
    IF v_email IS NOT NULL THEN
      profile_id := r.guardian_profile_id;
      email := v_email;
      name := r.guardian_name;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSIF NOT v_child AND r.profile_id IS NOT NULL THEN
    SELECT p.email INTO v_email FROM public.profiles p WHERE p.id = r.profile_id AND p.deleted_at IS NULL;
    IF v_email IS NOT NULL THEN
      profile_id := r.profile_id;
      email := v_email;
      name := nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), '');
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  profile_id := NULL;
  email := CASE WHEN v_child THEN r.guardian_email ELSE r.email END;
  name := CASE WHEN v_child THEN r.guardian_name ELSE nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), '') END;
  RETURN NEXT;
END $$;
REVOKE EXECUTE ON FUNCTION public.registration_surcharge_buyer(uuid) FROM public, anon, authenticated, service_role;
