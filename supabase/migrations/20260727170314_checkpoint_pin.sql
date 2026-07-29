-- Per-event checkpoint PIN: authorizes checkpoint-agent devices (Raspberry Pi
-- RFID readers on the trail) to download the bib<->EPC roster via the
-- checkpoint-roster edge function. Deliberately separate from checkin_pin,
-- which circulates among participants and must not unlock the tag map.
ALTER TABLE event_secrets ADD COLUMN IF NOT EXISTS checkpoint_pin text;
