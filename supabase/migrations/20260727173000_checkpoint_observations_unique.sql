-- Supabase was missing the UNIQUE that the local DB has had since 0009_checkpoints
-- ("first observation wins"). Dedup first: keep the earliest observation per
-- (checkpoint_id, bib_number); ties broken by id. Approved data deletion:
-- removes only redundant duplicate rows (volunteer double-taps + sync artifacts).
DELETE FROM checkpoint_observations a
USING checkpoint_observations b
WHERE a.checkpoint_id = b.checkpoint_id
  AND a.bib_number = b.bib_number
  AND (a.observed_at > b.observed_at
       OR (a.observed_at = b.observed_at AND a.id > b.id));

ALTER TABLE checkpoint_observations
  ADD CONSTRAINT checkpoint_observations_checkpoint_id_bib_number_key
  UNIQUE (checkpoint_id, bib_number);
