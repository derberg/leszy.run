-- backend/src/db/migrations/0009_checkpoints.sql

--> statement-breakpoint
CREATE TABLE checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  km_marker int,
  created_at timestamptz DEFAULT now(),
  synced_at timestamptz
);

--> statement-breakpoint
CREATE TABLE checkpoint_categories (
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, category_id)
);

--> statement-breakpoint
CREATE TABLE checkpoint_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  bib_number int NOT NULL,
  participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL,
  synced_at timestamptz,
  UNIQUE (checkpoint_id, bib_number)
);

--> statement-breakpoint
ALTER TABLE participants ADD COLUMN updated_at timestamptz;
