-- Competition change, task 8: a surcharge order whose buyer has no account yet (buyer_profile_id
-- NULL, only buyer_email, see registration_surcharge_buyer) is claimed by the first session whose
-- address equals buyer_email. One statement: the write is the check. Never a registration order.
CREATE OR REPLACE FUNCTION public.claim_surcharge_order(p_order_id uuid, p_profile_id uuid, p_email text)
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_order_id IS NULL OR p_profile_id IS NULL OR p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN false;
  END IF;
  UPDATE public.orders
     SET buyer_profile_id = p_profile_id
   WHERE id = p_order_id
     AND buyer_profile_id IS NULL
     AND kind = 'surcharge'
     AND lower(buyer_email) = lower(btrim(p_email))
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_surcharge_order(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_surcharge_order(uuid, uuid, text) TO service_role;
