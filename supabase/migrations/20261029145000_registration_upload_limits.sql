-- Size limits on the registration buckets, enforced by Storage itself.
-- * registration-pending: the browser PUTs regulamin PDFs and GPX files here
--   through a signed upload URL, so Storage is the only thing that sees the
--   bytes before upload-registration-file's finish step. 10 MB is the largest
--   file that step accepts (regulamin); GPX is held to 5 MB there.
--   No MIME restriction: browsers send GPX as anything from
--   application/gpx+xml to an empty type, and the finish step checks content.
-- * registration-files: written by the service role only, after validation.
--   The limits are defence in depth.
UPDATE storage.buckets
   SET file_size_limit = 10485760
 WHERE id = 'registration-pending';

UPDATE storage.buckets
   SET file_size_limit = 10485760,
       allowed_mime_types = ARRAY['image/jpeg', 'application/pdf', 'application/gpx+xml']
 WHERE id = 'registration-files';
