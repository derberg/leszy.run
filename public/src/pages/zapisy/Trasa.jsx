import { useState } from 'react'
import { useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import CourseMap from '../../components/registration/CourseMap.jsx'
import ElevationProfile from '../../components/registration/ElevationProfile.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import { labelCls, secondaryBtn } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'

// RA1b: one tab per GPX file (competitions sharing a course share a tab), the
// map, distance and climb, the elevation profile and the GPX download.

const km = (n) => (n == null ? '—' : `${String(Number(n.toFixed(1))).replace('.', ',')} km`)
const m = (n, sign) => (n == null ? '—' : `${sign}${Math.round(n)} m`)

/** The course view itself, also usable by the organizer preview. */
export function CourseView({ raw, backTo }) {
  const model = eventPageModel(raw)
  const [key, setKey] = useState(model.courses[0]?.key ?? null)
  const course = model.courses.find((c) => c.key === key) ?? model.courses[0]

  return (
    <div className="flex flex-col gap-4" data-testid="course-page">
      <PageTop back={backTo ? { to: backTo, label: 'Wróć' } : null} right={model.title} />
      <h1 className="font-display font-extrabold text-4xl uppercase text-apex-text-bright">Trasa</h1>
      {!course ? (
        <p className="text-base">Organizator nie dodał jeszcze trasy.</p>
      ) : (
        <>
          {model.courses.length > 1 && (
            <div className="flex gap-1.5" role="tablist">
              {model.courses.map((c) => (
                <button key={c.key} type="button" role="tab" aria-selected={c.key === course.key} onClick={() => setKey(c.key)}
                  className={`flex-1 min-h-11 border font-sans font-bold text-base whitespace-nowrap ${c.key === course.key
                    ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text bg-apex-surface'}`}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {model.courses.length === 1 && (
            <div className="flex"><span className="px-4 min-h-11 flex items-center border border-apex-yellow text-apex-yellow font-bold whitespace-nowrap" data-testid="course-tab">{course.label}</span></div>
          )}
          <span className="font-mono text-xs text-apex-muted -mt-2">{course.competitionNames}</span>

          <CourseMap key={course.key} points={Array.isArray(course.points) ? course.points : null} km={course.km} />

          <div className="grid grid-cols-3 border border-apex-border" data-testid="course-stats">
            <div className="p-2.5 border-r border-apex-border"><span className={labelCls}>Dystans</span><div className="font-mono text-lg text-apex-text-bright">{km(course.km)}</div></div>
            <div className="p-2.5 border-r border-apex-border"><span className={labelCls}>W górę</span><div className="font-mono text-lg text-apex-text-bright">{m(course.upM, '+')}</div></div>
            <div className="p-2.5"><span className={labelCls}>W dół</span><div className="font-mono text-lg text-apex-text-bright">{m(course.downM, '−')}</div></div>
          </div>

          {course.profile?.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className={labelCls}>Profil</span>
              <ElevationProfile profile={course.profile} />
            </div>
          )}

          {course.gpxUrl && <a href={course.gpxUrl} download className={secondaryBtn}>Pobierz GPX</a>}
        </>
      )}
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
