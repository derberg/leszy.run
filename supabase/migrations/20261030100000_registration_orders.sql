-- Race registration, plan 3 task 3: the order schema.
--
-- * orders: one checkout. Every amount is integer grosze, computed server-side
--   and frozen at creation. support_choice has no default and is required
--   whenever entry fees are due (Art. 10 ustawy o prawach konsumenta).
-- * order_lines: per-person / per-item amounts, so refunds are exact.
-- * payment_attempts: one order can hold several dpay transactions, because a
--   dpay transaction lives minutes and the payment window hours to days
--   (plan 3 ruling 1).
-- * payment_events: append-only log of every dpay request, IPN, status check
--   and refund. The payer e-mail is stored only as email_sha256 (ruling 5).
--   The payload must be an object with no `email` key at any depth, in any
--   case, and the response text must hold no address (ruling P3-R2). Callers
--   pass every payload through _shared/registration/redactDpay.js first; the
--   checks are only the backstop.
-- * refunds: one row per dpay refund call. Idempotency is ours: at most one
--   automatic refund per payment attempt (ruling 8), message_id unique.
-- * operator_alerts: things a person has to resolve (amount mismatch, an
--   unknown refund outcome, ...).
-- * registration_settings gains the payment window (a public wizard field).
-- * event_payout_details holds the per-event payout (recipient, NIP, IBAN, title)
--   in its own table, never on registration_settings: get-registration-event
--   returns the settings row whole to every club member (ruling P3-R1). Task 8
--   reads it owner-only, admin masked, like club_payout_details.
--   event_payout_history logs payout changes.
-- * registrations.order_id gets its FK (plan 2 left it bare).
-- * registration_support_fee / registration_payment_fee mirror money.js
--   (supportFee / paymentFee); a test compares them for every amount 0…100 000.
-- Every new table is service role only: RLS on, no policies, REVOKE ALL.

-- ---------------------------------------------------------------- fee functions

-- LESZY.RUN 2% of the entry fees, rounded half up. Same refusals as money.js.
CREATE FUNCTION public.registration_support_fee(p_entry integer, p_choice boolean) RETURNS integer
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = ''
AS $$
BEGIN
  IF p_entry IS NULL OR p_entry < 0 OR p_entry > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:entryTotal' USING ERRCODE = '22023';
  END IF;
  IF p_choice IS NULL THEN
    RAISE EXCEPTION 'support_choice_required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_choice THEN
    RETURN 0;
  END IF;
  RETURN ((2::bigint * p_entry + 50) / 100)::integer;
END $$;

-- dpay takes 0.9% of the charged total (min 0.20 zł), so the fee is grossed up:
-- max(20, ceil(subtotal * 9 / 991)) for subtotal > 0, else 0.
CREATE FUNCTION public.registration_payment_fee(p_subtotal integer) RETURNS integer
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = ''
AS $$
BEGIN
  IF p_subtotal IS NULL OR p_subtotal < 0 OR p_subtotal > 99999999 THEN
    RAISE EXCEPTION 'invalid_amount:subtotal' USING ERRCODE = '22023';
  END IF;
  IF p_subtotal = 0 THEN
    RETURN 0;
  END IF;
  RETURN greatest(20, (p_subtotal::bigint * 9 + 990) / 991)::integer;
END $$;

REVOKE EXECUTE ON FUNCTION public.registration_support_fee(integer, boolean) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.registration_payment_fee(integer)          FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.registration_support_fee(integer, boolean) TO service_role;
GRANT  EXECUTE ON FUNCTION public.registration_payment_fee(integer)          TO service_role;

-- ---------------------------------------------------------------- registration_settings

ALTER TABLE public.registration_settings
  ADD COLUMN payment_window_hours integer NOT NULL DEFAULT 168,
  ADD CONSTRAINT registration_settings_payment_window_hours_check CHECK (payment_window_hours BETWEEN 1 AND 336);

-- ---------------------------------------------------------------- per-event payout

-- 'club' pays out to club_payout_details; 'custom' to the recipient here. No row
-- means 'club'. Personal data when the recipient is a person: owner-only reads.
CREATE TABLE public.event_payout_details (
  event_id         uuid PRIMARY KEY REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  payout_mode      text NOT NULL DEFAULT 'club',
  payout_recipient text,
  payout_tax_id    text,
  payout_iban      text,
  payout_title     text,
  updated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_payout_details_payout_mode_check CHECK (payout_mode IN ('club', 'custom'))
);
CREATE INDEX event_payout_details_updated_by_idx ON public.event_payout_details (updated_by);

CREATE TABLE public.event_payout_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  old        jsonb,
  new        jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_payout_history_event_id_idx   ON public.event_payout_history (event_id);
CREATE INDEX event_payout_history_changed_by_idx ON public.event_payout_history (changed_by);

-- ---------------------------------------------------------------- orders

CREATE TABLE public.orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES public.registration_settings(event_id) ON DELETE RESTRICT,
  buyer_profile_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  buyer_email           text,
  status                text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  entry_total           integer NOT NULL CHECK (entry_total >= 0),
  extras_total          integer NOT NULL CHECK (extras_total >= 0),
  donation              integer NOT NULL CHECK (donation >= 0),
  support_choice        boolean,
  support_fee           integer NOT NULL CHECK (support_fee >= 0),
  payment_fee           integer NOT NULL CHECK (payment_fee >= 0),
  total                 integer NOT NULL CHECK (total >= 0),
  -- The tier the prices came from. Repricing deletes tiers; the amounts above stay frozen.
  tier_id               uuid REFERENCES public.price_tiers(id) ON DELETE SET NULL,
  expires_at            timestamptz NOT NULL,
  paid_at               timestamptz,
  paid_transaction_id   text UNIQUE,
  reminder_sent_at      timestamptz,
  expired_notified_at   timestamptz,
  last_status_check_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- No preselected support choice: payable entry fees need an explicit true/false.
  CONSTRAINT orders_support_choice_check CHECK (entry_total = 0 OR support_choice IS NOT NULL),
  CONSTRAINT orders_amounts_add_up_check
    CHECK (total = entry_total + extras_total + donation + support_fee + payment_fee),
  -- A free order (total 0) is paid with no dpay transaction.
  CONSTRAINT orders_paid_check
    CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND (paid_transaction_id IS NOT NULL OR total = 0)))
);
CREATE INDEX orders_event_id_idx          ON public.orders (event_id);
CREATE INDEX orders_buyer_profile_id_idx  ON public.orders (buyer_profile_id);
CREATE INDEX orders_tier_id_idx           ON public.orders (tier_id);
CREATE INDEX orders_status_expires_at_idx ON public.orders (status, expires_at);
-- The "Zgłoszenie wygasło" notice scan; expired orders are kept for years.
CREATE INDEX orders_expired_unnotified_idx ON public.orders (expires_at)
  WHERE status = 'expired' AND expired_notified_at IS NULL;

ALTER TABLE public.registrations
  ADD CONSTRAINT registrations_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

-- extra_variant_id is a plain uuid: the extras tables come in a later plan.
-- tier_label / tier_ends_on snapshot the price tier the amount came from
-- (ruling P3-R3): repricing deletes price_tiers rows, and a dispute needs them.
CREATE TABLE public.order_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('entry', 'extra', 'donation')),
  registration_id  uuid REFERENCES public.registrations(id) ON DELETE RESTRICT,
  extra_variant_id uuid,
  qty              integer NOT NULL DEFAULT 1 CHECK (qty >= 1),
  amount           integer NOT NULL CHECK (amount >= 0),
  refunded         integer NOT NULL DEFAULT 0,
  tier_label       text,
  tier_ends_on     date,
  CONSTRAINT order_lines_refunded_check CHECK (refunded BETWEEN 0 AND amount),
  CONSTRAINT order_lines_entry_registration_check CHECK (kind <> 'entry' OR registration_id IS NOT NULL)
);
CREATE INDEX order_lines_order_id_idx         ON public.order_lines (order_id);
CREATE INDEX order_lines_registration_id_idx  ON public.order_lines (registration_id);
CREATE INDEX order_lines_extra_variant_id_idx ON public.order_lines (extra_variant_id);

-- ---------------------------------------------------------------- payments

CREATE TABLE public.payment_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  dpay_transaction_id text NOT NULL UNIQUE,
  grosze              integer NOT NULL CHECK (grosze > 0),
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'refunded')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz
);
CREATE INDEX payment_attempts_order_id_idx ON public.payment_attempts (order_id);

-- Append-only. order_id / payment_attempt_id are null for an IPN that names
-- nothing we know (forged or cross-order). The payload never holds the payer
-- e-mail: strip it and store its SHA-256 instead (ruling 5).
CREATE TABLE public.payment_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  payment_attempt_id uuid REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('register', 'ipn', 'status_check', 'refund')),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_sha256       text CHECK (email_sha256 ~ '^[0-9a-f]{64}$'),
  checksum_ok        boolean,
  response           text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  -- jsonb_path_exists (not the _tz variant) is immutable, so it may sit in a CHECK.
  CONSTRAINT payment_events_no_plain_email_check CHECK (NOT jsonb_path_exists(payload,
    'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^email$" flag "i")')),
  CONSTRAINT payment_events_response_no_email_check CHECK (response IS NULL OR (
    response !~* '"email"[[:space:]]*:'
    AND response !~* '[^[:space:]@"]+@[^[:space:]@"]+\.[a-z]{2,}'))
);
CREATE INDEX payment_events_order_id_idx           ON public.payment_events (order_id);
CREATE INDEX payment_events_payment_attempt_id_idx ON public.payment_events (payment_attempt_id);

-- One row per dpay refund call. message_id is our DigitalPayments-PSP-Message-ID
-- (dpay caps it at 24 characters; it labels the transfer, it does not dedupe).
-- 'unknown' (timeout, 5xx) is alerted and never retried automatically; only
-- 'insufficient_balance' (406) is retried, through next_retry_at.
CREATE TABLE public.refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  payment_attempt_id uuid NOT NULL REFERENCES public.payment_attempts(id) ON DELETE RESTRICT,
  order_line_id      uuid REFERENCES public.order_lines(id) ON DELETE RESTRICT,
  amount             integer NOT NULL CHECK (amount > 0),
  kind               text NOT NULL CHECK (kind IN ('automatic', 'organizer')),
  reason             text NOT NULL,
  requested_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  message_id         text NOT NULL UNIQUE CHECK (char_length(message_id) BETWEEN 1 AND 24),
  dpay_status        text NOT NULL DEFAULT 'pending'
    CHECK (dpay_status IN ('pending', 'accepted', 'rejected', 'insufficient_balance', 'unknown')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Ruling 8: at most one automatic refund per payment attempt.
CREATE UNIQUE INDEX refunds_automatic_attempt_key
  ON public.refunds (payment_attempt_id) WHERE kind = 'automatic';
CREATE INDEX refunds_order_id_idx           ON public.refunds (order_id);
CREATE INDEX refunds_payment_attempt_id_idx ON public.refunds (payment_attempt_id);
CREATE INDEX refunds_order_line_id_idx      ON public.refunds (order_line_id);
CREATE INDEX refunds_requested_by_idx       ON public.refunds (requested_by);
-- The 406 (insufficient_balance) retry job.
CREATE INDEX refunds_next_retry_at_idx      ON public.refunds (next_retry_at) WHERE next_retry_at IS NOT NULL;

CREATE TABLE public.operator_alerts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  order_id   uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz
);
CREATE INDEX operator_alerts_order_id_idx ON public.operator_alerts (order_id);
-- The alert mailer.
CREATE INDEX operator_alerts_unsent_idx   ON public.operator_alerts (created_at) WHERE emailed_at IS NULL;

-- ---------------------------------------------------------------- lockdown

-- Service role only. RLS with no policies plus REVOKE, because RLS does not
-- govern TRUNCATE.
ALTER TABLE public.orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_lines          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_alerts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_payout_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_payout_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.orders               FROM anon, authenticated;
REVOKE ALL ON public.order_lines          FROM anon, authenticated;
REVOKE ALL ON public.payment_attempts     FROM anon, authenticated;
REVOKE ALL ON public.payment_events       FROM anon, authenticated;
REVOKE ALL ON public.refunds              FROM anon, authenticated;
REVOKE ALL ON public.operator_alerts      FROM anon, authenticated;
REVOKE ALL ON public.event_payout_history FROM anon, authenticated;
REVOKE ALL ON public.event_payout_details FROM anon, authenticated;
