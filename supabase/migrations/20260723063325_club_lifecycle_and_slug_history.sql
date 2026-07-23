-- Club membership lifecycle: leaving/removal is a soft state change, not a
-- row delete, so club history survives members moving between clubs.
ALTER TABLE club_members ADD COLUMN left_at TIMESTAMPTZ;
ALTER TABLE club_members DROP CONSTRAINT club_members_status_chk;
ALTER TABLE club_members ADD CONSTRAINT club_members_status_chk
  CHECK (status IN ('active','pending','left','removed'));

-- Append-only membership history (multiple stints per club survive here even
-- though club_members keeps one row per (club_id,user_id)).
CREATE TABLE club_membership_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event       TEXT NOT NULL CHECK (event IN ('joined','left','removed','role_changed')),
  role        TEXT,
  actor_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_club_membership_log_club ON club_membership_log(club_id, occurred_at);
CREATE INDEX idx_club_membership_log_user ON club_membership_log(user_id);

-- Former slugs — /klub/<old_slug> keeps working (static redirect stub) and
-- get-club can resolve them. A club may reclaim its own former slug.
CREATE TABLE club_slug_history (
  old_slug   TEXT PRIMARY KEY,
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_club_slug_history_club ON club_slug_history(club_id);

-- Service-role only (same pattern as club_members / club_invites).
ALTER TABLE club_membership_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_slug_history ENABLE ROW LEVEL SECURITY;
