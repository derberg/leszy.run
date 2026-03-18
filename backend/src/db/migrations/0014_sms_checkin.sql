-- Add slug to events
ALTER TABLE events ADD COLUMN slug TEXT UNIQUE;

-- Generate slugs for existing events
UPDATE events SET slug = lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'))
WHERE slug IS NULL;

-- Handle any duplicate slugs by appending id prefix
UPDATE events e SET slug = slug || '-' || left(id::text, 8)
WHERE (SELECT count(*) FROM events e2 WHERE e2.slug = e.slug) > 1;

-- Now make slug NOT NULL
ALTER TABLE events ALTER COLUMN slug SET NOT NULL;

-- Add phone and sms_sent_at to participants
ALTER TABLE participants ADD COLUMN phone TEXT;
ALTER TABLE participants ADD COLUMN sms_sent_at TIMESTAMPTZ;

-- Create event_documents table
CREATE TABLE event_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT,
  required_for TEXT NOT NULL DEFAULT 'all',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);

-- Forward sync trigger for event_documents
CREATE OR REPLACE FUNCTION trg_fn_reset_synced_at_event_documents()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.synced_at IS DISTINCT FROM NEW.synced_at THEN
    RETURN NEW;
  END IF;
  NEW.synced_at := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reset_synced_at_event_documents
BEFORE UPDATE ON event_documents
FOR EACH ROW EXECUTE FUNCTION trg_fn_reset_synced_at_event_documents();

-- Create checkins table (reverse sync: Supabase → local, NO trg_reset_synced_at)
CREATE TABLE checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);

-- Create checkin_documents table (reverse sync: Supabase → local, NO trg_reset_synced_at)
CREATE TABLE checkin_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id UUID NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES event_documents(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  UNIQUE (checkin_id, document_id)
);
