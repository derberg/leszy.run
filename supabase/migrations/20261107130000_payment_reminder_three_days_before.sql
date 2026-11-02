-- The payment reminder comes 3 days before the order expires, not at half the window.
--
-- At half the window it was useless for „do końca zapisów”: an order placed two months before
-- the close was reminded a month before it expired. Three days before expiry is what a runner
-- can act on. A window shorter than that (an order placed close to the close) is reminded at its
-- half instead, so the reminder never goes out the moment the order is placed.
--
-- The 24-hour window gets no reminder at all: the confirmation e-mail with the pay link is less
-- than a day old. Only windows longer than 24 hours are reminded (was: 6 hours or more).
--
-- Recreated from 20261030125000; only the two window conditions change. CREATE OR REPLACE keeps
-- the grants; the REVOKE / GRANT below restates them.

CREATE OR REPLACE FUNCTION public.claim_payment_reminders(p_limit integer DEFAULT 100) RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM public.orders o
     WHERE o.status = 'pending' AND o.reminder_sent_at IS NULL
       AND o.expires_at > now()
       AND o.expires_at - o.created_at > interval '24 hours'
       AND now() >= greatest(o.expires_at - interval '3 days',
                             o.created_at + (o.expires_at - o.created_at) / 2)
     ORDER BY o.created_at
     LIMIT greatest(p_limit, 0)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o SET reminder_sent_at = now()
    FROM due WHERE o.id = due.id AND o.reminder_sent_at IS NULL
  RETURNING o.id;
END $$;

REVOKE EXECUTE ON FUNCTION public.claim_payment_reminders(integer) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_payment_reminders(integer) TO service_role;
