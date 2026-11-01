-- Plan 6, task 4: record_refund refuses p_kind = 'organizer'. Recreated from
-- 20261102100000_organizer_panel.sql with that one check added; everything else is unchanged.
-- The organizer's refunds are reserved by reserve_organizer_refund and settled by
-- finish_organizer_refund, and settle_refund already refuses them (20261102102000).

CREATE OR REPLACE FUNCTION public.record_refund(p_attempt_id uuid, p_grosze integer, p_kind text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  a     public.payment_attempts%ROWTYPE;
  v_id  uuid := gen_random_uuid();
  v_msg text := left(replace(v_id::text, '-', ''), 24);
BEGIN
  -- An organizer refund has a line, an actor and a request key, and only reserve_organizer_refund
  -- writes those. A row from here could be settled by neither settle_refund nor
  -- finish_organizer_refund (Task 3's concern 2).
  IF p_kind = 'organizer' THEN
    RAISE EXCEPTION 'organizer_refund';
  END IF;
  IF p_grosze IS NULL OR p_grosze <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  -- D3-1: the order before the attempt, as confirm_order takes them.
  PERFORM 1 FROM public.orders o
   WHERE o.id = (SELECT pa.order_id FROM public.payment_attempts pa WHERE pa.id = p_attempt_id)
     FOR UPDATE;
  SELECT * INTO a FROM public.payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_grosze + public.registration_attempt_refunds_held(a.id) > a.grosze THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  INSERT INTO public.refunds (id, order_id, payment_attempt_id, amount, kind, reason, message_id)
  VALUES (v_id, a.order_id, a.id, p_grosze, p_kind, p_reason, v_msg);
  RETURN jsonb_build_object('refundId', v_id, 'messageId', v_msg);
END $$;
