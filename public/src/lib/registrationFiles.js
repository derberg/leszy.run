import { supabase } from './supabase.js'

// Public URL of a file in the registration-files bucket (posters, regulamins,
// GPX). `path` is registration_uploads.path, relative to the bucket.
export function publicFileUrl(path) {
  return supabase.storage.from('registration-files').getPublicUrl(path).data.publicUrl
}
