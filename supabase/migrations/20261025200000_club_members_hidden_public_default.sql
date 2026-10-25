-- New memberships are clubmates-only until the person decides otherwise. The
-- public club page that hidden_public governs is not shipped, so nobody can
-- make that choice today, and the old default (false) put everyone on the
-- page the moment it comes back. The join and create functions now send true;
-- this covers any other insert path. Existing rows are left as they are.
ALTER TABLE public.club_members ALTER COLUMN hidden_public SET DEFAULT true;
