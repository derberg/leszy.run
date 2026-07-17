-- Teams/Clubs Phase A — foundation schema.
--
-- DESTRUCTIVE: section 1 wipes the single existing loose club and nulls
-- profiles.club_id. This is intentional (the club feature is hidden/beta, ~2
-- users; the operator pre-authorized the wipe). It runs on merge to main via
-- `supabase db push` in the release pipeline.

-- 1. Wipe existing loose clubs (feature is hidden; ~2 users)
UPDATE profiles SET club_id = NULL;
DELETE FROM clubs;

-- 2. Extend clubs into an owned entity
ALTER TABLE clubs ADD COLUMN owner_id         UUID REFERENCES profiles(id) ON DELETE RESTRICT;
ALTER TABLE clubs ADD COLUMN slug             TEXT UNIQUE;
ALTER TABLE clubs ADD COLUMN logo_url         TEXT;
ALTER TABLE clubs ADD COLUMN description       TEXT;
ALTER TABLE clubs ADD COLUMN city             TEXT;
ALTER TABLE clubs ADD COLUMN voivodeship      TEXT;
ALTER TABLE clubs ADD COLUMN is_public        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE clubs ADD COLUMN pending_owner_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

-- 3. Membership
CREATE TABLE club_members (
  club_id        UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  status         TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'pending'
  hidden_public  BOOLEAN NOT NULL DEFAULT false,
  joined_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id),
  CONSTRAINT club_members_role_chk   CHECK (role   IN ('owner','admin','member')),
  CONSTRAINT club_members_status_chk CHECK (status IN ('active','pending'))
);
CREATE INDEX idx_club_members_user        ON club_members(user_id);
CREATE INDEX idx_club_members_club_status ON club_members(club_id, status);

-- 4. Invites (used by Plan 2; table created now so schema is complete)
CREATE TABLE club_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                     -- 'link' | 'direct'
  code            TEXT UNIQUE,
  target_email    TEXT,
  target_username TEXT,
  created_by      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  uses            INTEGER NOT NULL DEFAULT 0,
  revoked         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT club_invites_kind_chk CHECK (kind IN ('link','direct'))
);
CREATE INDEX idx_club_invites_code ON club_invites(code) WHERE code IS NOT NULL;
CREATE INDEX idx_club_invites_club ON club_invites(club_id);

-- 5. Profile nickname (freeform, optional, non-unique)
ALTER TABLE profiles ADD COLUMN nickname TEXT;

-- 6. RLS: membership + invites are service-role only (no public/authenticated policies)
ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_invites ENABLE ROW LEVEL SECURITY;
-- clubs keeps its existing public-read policy (needed by search_clubs + render-club)

-- 7. Storage bucket for club logos (public read)
INSERT INTO storage.buckets (id, name, public)
VALUES ('club-logos', 'club-logos', true)
ON CONFLICT (id) DO NOTHING;
