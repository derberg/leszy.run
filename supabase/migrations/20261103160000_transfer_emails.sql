-- Plan 7, task 7: the transfer e-mails go out at most once.
--
-- Every runner e-mail is claimed before it is sent: the edge function stamps the column with one
-- UPDATE … WHERE <column> IS NULL and sends only when that UPDATE touched the row, so a second
-- caller (a double submit, a retried request) finds it stamped and sends nothing. Plan 3's rule
-- (sendOrderConfirmation) for what follows: a send that certainly failed gives the claim back
-- (NULL again), and registration-jobs re-sends the accepted, confirmation and holder e-mails of a
-- transfer whose column is still NULL 10 minutes after it was accepted, once (a failed re-send
-- keeps the claim and alerts the operator); a send whose fate is unknown (a SendGrid timeout)
-- keeps the claim and alerts the operator with the transfer id and the column only.
--
--   invite_emailed_at        the invite to to_email (transfer-invite create)
--   cancel_emailed_at        „Zaproszenie cofnięte” to to_email (transfer-invite cancel)
--   accepted_emailed_at      „Pakiet przejęła …” to the sender (transfer-accept)
--   confirmation_emailed_at  „Jesteś na liście” to the recipient (transfer-accept)
--   holder_emailed_at        „Pakiet przekazany” to the old holder after an organizer transfer
--
-- transfers stays service-role only (20261103100000): no grant changes here.

ALTER TABLE public.transfers
  ADD COLUMN invite_emailed_at       timestamptz,
  ADD COLUMN cancel_emailed_at       timestamptz,
  ADD COLUMN accepted_emailed_at     timestamptz,
  ADD COLUMN confirmation_emailed_at timestamptz,
  ADD COLUMN holder_emailed_at       timestamptz;
