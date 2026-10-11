-- The weekly digest had no record of what it had already sent. It recomputed a
-- rolling 7-day window on every run and mailed everyone who had anything in it,
-- so any re-run inside the window — and a re-run is exactly what an operator
-- does after the Monday job fails part-way through the subscriber list — sent
-- the same digest a second time to everyone it had already reached.
--
-- One timestamp per subscriber, stamped only after SendGrid accepts the
-- message, so a failed send is retried rather than swallowed.

alter table public.profiles
  add column if not exists digest_sent_at timestamptz;

comment on column public.profiles.digest_sent_at is
  'When the weekly digest was last successfully mailed to this user. Bounds the next digest window so a re-run cannot repeat a week.';
