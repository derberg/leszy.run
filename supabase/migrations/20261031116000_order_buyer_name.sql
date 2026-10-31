-- Race registration, plan 4 task 4a fix round 1 (m-1): the name the buyer typed, on the order.
--
-- A paid group's consent e-mails go out when the payment lands (settleConfirmOutcome), in
-- another process than create-order, so the name the buyer typed („Nie startuję”: the buyer is
-- in no row of the order) has to be stored to name them as the person who provided the data
-- (Art. 14). create-order writes it right after create_order. Without it the e-mail fell back
-- to the account's display name, and then to the payer's address in an e-mail body.
--
-- It is the buyer's personal data like buyer_email, so it goes where buyer_email goes:
-- delete-my-account nulls both, export-my-data returns both, and the purge of an order that
-- expired or was cancelled with no money moved nulls both (purge_expired_registrations,
-- re-created below with buyer_name added and nothing else changed).

ALTER TABLE public.orders ADD COLUMN buyer_name text;

CREATE OR REPLACE FUNCTION public.purge_expired_registrations() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_regs   integer;
  v_acc    integer;
  v_orders integer;
  v_gone   constant text := 'Usunięte zgłoszenie';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.purge_orders (id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE pg_temp.purge_orders;
  INSERT INTO pg_temp.purge_orders (id)
  SELECT o.id FROM public.orders o
   WHERE (o.status = 'expired' AND o.expires_at <= now() - interval '30 days')
      OR (o.status = 'cancelled' AND o.cancelled_at <= now() - interval '30 days');

  UPDATE public.registrations r
     SET first_name = v_gone, last_name = v_gone, profile_id = NULL,
         email = NULL, phone = NULL, birth_date = NULL, city = NULL, club = NULL,
         ice_name = NULL, ice_phone = NULL, nationality = NULL,
         guardian_profile_id = NULL, guardian_name = NULL, guardian_email = NULL
    FROM pg_temp.purge_orders p
   WHERE r.order_id = p.id
     AND r.status IN ('expired', 'cancelled')
     AND (r.first_name, r.last_name, r.profile_id, r.email, r.phone, r.birth_date, r.city, r.club,
          r.ice_name, r.ice_phone, r.nationality, r.guardian_profile_id, r.guardian_name, r.guardian_email)
         IS DISTINCT FROM
         (v_gone, v_gone, NULL::uuid, NULL::text, NULL::text, NULL::date, NULL::text, NULL::text,
          NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text, NULL::text);
  GET DIAGNOSTICS v_regs = ROW_COUNT;

  UPDATE public.consent_acceptances ca
     SET ip = NULL, user_agent = NULL
    FROM public.registrations r
    JOIN pg_temp.purge_orders p ON p.id = r.order_id
   WHERE ca.registration_id = r.id
     AND r.status IN ('expired', 'cancelled')
     AND (ca.ip IS NOT NULL OR ca.user_agent IS NOT NULL);
  GET DIAGNOSTICS v_acc = ROW_COUNT;

  UPDATE public.orders o
     SET buyer_email = NULL, buyer_name = NULL
    FROM pg_temp.purge_orders p
   WHERE o.id = p.id
     AND (o.buyer_email IS NOT NULL OR o.buyer_name IS NOT NULL)
     AND o.paid_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.payment_attempts a
                      WHERE a.order_id = o.id AND a.status IN ('paid', 'refunded'))
     AND NOT EXISTS (SELECT 1 FROM public.refunds f WHERE f.order_id = o.id);
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  RETURN v_regs + v_acc + v_orders;
END $$;
REVOKE EXECUTE ON FUNCTION public.purge_expired_registrations() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_registrations() TO service_role;
