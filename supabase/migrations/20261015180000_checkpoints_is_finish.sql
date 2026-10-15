-- Marks the checkpoint where a volunteer records finishers ("Ręczna meta"). The
-- admin live view compares those entries with the chip finish and highlights a
-- difference over 60 s. On 2026-08-07 five chip finishes came 1.4 to 15.5 min after
-- the volunteer's entry. Nothing reads it to change a result.
ALTER TABLE public.checkpoints ADD COLUMN is_finish boolean NOT NULL DEFAULT false;
