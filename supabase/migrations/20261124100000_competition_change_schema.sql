-- Competition change: a dearer move creates a "surcharge" order that is paid
-- online and moves the entry when it is confirmed.
--
-- orders.buyer_profile_id and buyer_email are already nullable and no CHECK
-- demands a buyer, so a surcharge whose buyer is only an e-mail needs no
-- relaxation. refunds.reason is free text (no CHECK), so 'competition_change'
-- needs no constraint change. RLS is already on and anon/authenticated hold no
-- privilege on these tables, so there are no new grants.

ALTER TABLE public.orders
  ADD COLUMN kind text NOT NULL DEFAULT 'registration',
  ADD COLUMN surcharge_registration_id uuid REFERENCES public.registrations(id) ON DELETE RESTRICT,
  ADD COLUMN surcharge_from_category_id uuid,
  ADD COLUMN surcharge_to_category_id uuid,
  ADD COLUMN surcharge_list_price integer,
  ADD COLUMN surcharge_price integer;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_kind_check CHECK (kind IN ('registration', 'surcharge')),
  ADD CONSTRAINT orders_surcharge_columns_check CHECK (
    (kind = 'surcharge') = (
      surcharge_registration_id IS NOT NULL
      AND surcharge_from_category_id IS NOT NULL
      AND surcharge_to_category_id IS NOT NULL
      AND surcharge_list_price IS NOT NULL
      AND surcharge_price IS NOT NULL
    )
    AND (kind = 'surcharge' OR (
      surcharge_registration_id IS NULL
      AND surcharge_from_category_id IS NULL
      AND surcharge_to_category_id IS NULL
      AND surcharge_list_price IS NULL
      AND surcharge_price IS NULL
    ))
  );

-- One open surcharge per registration.
CREATE UNIQUE INDEX orders_one_open_surcharge
  ON public.orders (surcharge_registration_id)
  WHERE kind = 'surcharge' AND status = 'pending';

ALTER TABLE public.order_lines DROP CONSTRAINT order_lines_kind_check;
ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_kind_check CHECK (kind IN ('entry', 'extra', 'donation', 'surcharge')),
  ADD CONSTRAINT order_lines_surcharge_registration_check
    CHECK (kind <> 'surcharge' OR registration_id IS NOT NULL);
