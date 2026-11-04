-- Storage for the public site's calendar data, moved out of the public git
-- repository (it held every published race as public/public/kalendarz/.manifest.json
-- plus one OG image per race).
--
-- * calendar-manifests: PRIVATE. kalendarz.json, listy.json, events.json — the
--   whole dataset. Written by the operator's publish scripts
--   (backend/scripts/publish-*.js --apply) and read by the Vercel build
--   (public/scripts/fetch-manifests.js), both with the service role, which
--   bypasses RLS. No policy is created, so anon and authenticated can neither
--   read nor list it.
-- * calendar-og: PUBLIC. kalendarz/<slug>/og.png, the link-preview images, served
--   at https://www.leszy.run/kalendarz/<slug>/og.png through a rewrite in
--   public/vercel.json. Public bucket objects are served by URL without a
--   policy; no client policy is created, so nobody can list the bucket or write
--   to it. Only the service role writes.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('calendar-manifests', 'calendar-manifests', false, 52428800, ARRAY['application/json'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('calendar-og', 'calendar-og', true, 2097152, ARRAY['image/png'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
