import { useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import CoursePanel from '../../components/registration/CoursePanel.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'

// RA1b: one tab per GPX file (competitions sharing a course share a tab), the
// map, distance and climb, the elevation profile and the GPX download.

/** The course view itself, also usable by the organizer preview. */
export function CourseView({ raw, backTo }) {
  const model = eventPageModel(raw)
  return (
    <div className="flex flex-col gap-4" data-testid="course-page">
      <PageTop back={backTo ? { to: backTo, label: 'Wróć' } : null} right={model.title} />
      <h1 className="font-display font-extrabold text-4xl uppercase text-apex-text-bright">Trasa</h1>
      {model.courses.length === 0
        ? <p className="text-base">Organizator nie dodał jeszcze trasy.</p>
        : <CoursePanel courses={model.courses} download />}
    </div>
  )
}

function Seo({ raw }) {
  useSeo({ title: `Trasa — ${raw.name}`, path: `/events/${raw.slug}/trasa`, description: `Trasa zawodów ${raw.name}: mapa, profil wysokości i plik GPX.` })
  return null
}

export default function Trasa() {
  const { slug } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} /><CourseView raw={raw} backTo={eventPath(raw.slug)} /></>}
    </RegistrationShell>
  )
}
