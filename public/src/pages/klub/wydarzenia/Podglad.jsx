import { Navigate, useParams } from 'react-router-dom'

// /klub/:slug/wydarzenia/:eventId/podglad — the organizer's „Podgląd jako
// zawodnik” (members only, preview-registration-event). The route exists now
// so `:step` never swallows `podglad`; the preview itself renders the runner's
// event page, which comes with the public event page.
export default function Podglad() {
  const { slug, eventId } = useParams()
  return <Navigate to={`/klub/${slug}/wydarzenia/${eventId}/publikacja`} replace />
}
