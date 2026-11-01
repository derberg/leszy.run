-- Plan 7, task 7: the transfer e-mails go out at most once.
--
-- Every runner e-mail is claimed before it is sent: the edge function stamps the column with one
-- UPDATE … WHERE <column> IS NULL and sends only when that UPDATE touched the row, so a second
-- caller (a double submit, a retried request) finds it stamped and sends nothing. The stamp is the
-- claim, not a delivery receipt: a send that fails after it is not retried.
--
--   invite_emailed_at        the invite to to_email (transfer-invite create)
--   cancel_emailed_at        „Zaproszenie cofnięte” to to_email (transfer-invite cancel)
--   accepted_emailed_at      „Pakiet przejęła …” to the sender (transfer-accept)
--   confirmation_emailed_at  „Jesteś na liście” to the recipient (transfer-accept)
--
-- transfers stays service-role only (20261103100000): no grant changes here.

ALTER TABLE public.transfers
  ADD COLUMN invite_emailed_at       timestamptz,
  ADD COLUMN cancel_emailed_at       timestamptz,
  ADD COLUMN accepted_emailed_at     timestamptz,
  ADD COLUMN confirmation_emailed_at timestamptz;
