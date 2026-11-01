-- Plan 6, task 5 (ledger item carried from Task 2): no confirmation e-mail for an order whose
-- entries were all cancelled or refunded before registration-jobs' lost-confirmation step ran.
--
-- Since Plan 6 an organizer can cancel a confirmed entry, or refund it whole (finish_organizer_refund
-- then cancels it), while the order stays 'paid'. claim_confirmation_resends (20261030125000) handed
-- out every paid order with no confirmation_sent_at 10 min after payment, so a runner whose entry was
-- already gone got „Opłacone” for it. Recreated with one change: the due orders are still stamped
-- (so they are never looked at again: there is nothing left to confirm), but only an order with at
-- least one registration still 'confirmed' is returned for the e-mail.

CREATE OR REPLACE FUNCTION public.claim_confirmation_resends(p_limit integer DEFAULT 50) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'paid' AND o.confirmation_sent_at IS NULL
       AND o.paid_at <= now() - interval '10 minutes'
     ORDER BY o.paid_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.orders o SET confirmation_sent_at = now()
      FROM due WHERE o.id = due.id AND o.confirmation_sent_at IS NULL
    RETURNING o.id
  )
  SELECT c.id FROM claimed c
   WHERE EXISTS (SELECT 1 FROM public.registrations r WHERE r.order_id = c.id AND r.status = 'confirmed');
END $$;

REVOKE EXECUTE ON FUNCTION public.claim_confirmation_resends(integer) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_confirmation_resends(integer) TO service_role;
