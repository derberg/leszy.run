-- Set when a participant came but will not start (they handed the bib back).
-- Race start seeds their result as DNS and the detector ignores their tag.
ALTER TABLE public.participants ADD COLUMN withdrawn_at timestamptz;
