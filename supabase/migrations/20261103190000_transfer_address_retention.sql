-- Plan 7, final review I-3: purge_registration_contact_data also clears transfers.to_email.
--
-- An invite's address belongs to somebody who may never accept, have an account or an entry, and
-- nothing else ever cleared it. 30 days after the race (the same Warsaw-day cutoff as the phone and
-- ICE data) every transfer of the event loses to_email; an invite still pending is expired first.
-- An accept by the invited address itself clears it at once (accept_transfer, 20261103150000), and
-- an organizer transfer never stores one. The rest of the body is 20261101150000's.

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
     SET phone = NULL, ice_name = NULL, ice_phone = NULL, guardian_name = NULL, guardian_email = NULL
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
