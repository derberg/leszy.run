// Storage paths in a registration event's raw snapshot → public URLs.
// registration_raw (SQL) knows the paths in the public registration-files
// bucket but not the project URL; public/api/event.js and the organizer
// preview know the URL. No imports: api/event.js runs as a Vercel Function,
// where the Vite alias does not exist.

const BUCKET = 'registration-files'

/**
 * @param {object} raw registration_raw output (posterPath, regulamin.path, competitions[].course.gpxPath)
 * @param {string} supabaseUrl the project URL, e.g. https://<ref>.supabase.co
 * @returns {object} a copy with posterUrl, regulamin.url (for a PDF) and course.gpxUrl, and no paths
 */
export function withFileUrls(raw, supabaseUrl) {
  const base = `${String(supabaseUrl).replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}/`
  const url = (path) => (path ? base + path.split('/').map(encodeURIComponent).join('/') : null)
  const { posterPath, regulamin, competitions, ...rest } = raw
  const { path: regulaminPath, ...reg } = regulamin ?? {}
  return {
    ...rest,
    posterUrl: url(posterPath),
    regulamin: { ...reg, url: reg.kind === 'pdf' ? url(regulaminPath) : (reg.url ?? null) },
    competitions: (competitions ?? []).map(({ course, ...c }) => {
      if (!course) return { ...c, course: null }
      const { gpxPath, ...k } = course
      return { ...c, course: { ...k, gpxUrl: url(gpxPath) } }
    }),
  }
}
