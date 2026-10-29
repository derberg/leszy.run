import { lazy, Suspense, useState } from 'react'
import ElevationProfile from './ElevationProfile.jsx'
import { labelCls, secondaryBtn } from './ui.js'

// The course block of RA1b, shared by the Trasa page and the event page (RA1):
// one tab per GPX file (competitions sharing a course share a tab), the map,
// distance and climb, the elevation profile and, on the Trasa page, the GPX
// download. `courses` is eventPageModel().courses.
//
// The map is react-leaflet, so it loads as its own chunk after the page has
// painted; a block of the map's height holds its place meanwhile.

const CourseMap = lazy(() => import('./CourseMap.jsx'))

const km = (n) => (n == null ? '—' : `${String(Number(n.toFixed(1))).replace('.', ',')} km`)
const m = (n, sign) => (n == null ? '—' : `${sign}${Math.round(n)} m`)

/**
 * @param {{ courses: object[], compact?: boolean, download?: boolean }} p
 */
export default function CoursePanel({ courses, compact = false, download = false }) {
  const [key, setKey] = useState(courses[0]?.key ?? null)
  const course = courses.find((c) => c.key === key) ?? courses[0]
  if (!course) return null
  const height = compact ? 'h-[280px] md:h-[360px]' : 'h-[360px] md:h-[440px]'

  return (
    <div className="flex flex-col gap-4" data-testid="course-panel">
      {courses.length > 1 && (
        <div className="flex gap-1.5" role="tablist">
          {courses.map((c) => (
            <button key={c.key} type="button" role="tab" aria-selected={c.key === course.key} onClick={() => setKey(c.key)}
              className={`flex-1 min-w-0 min-h-11 border font-sans font-bold text-base whitespace-nowrap ${c.key === course.key
                ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text bg-apex-surface'}`}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      {courses.length === 1 && (
        <div className="flex"><span className="px-4 min-h-11 flex items-center border border-apex-yellow text-apex-yellow font-bold whitespace-nowrap" data-testid="course-tab">{course.label}</span></div>
      )}
      <span className="font-mono text-xs text-apex-muted -mt-2" data-testid="course-names">{course.competitionNames}</span>

      <Suspense fallback={<div className={`${height} border border-apex-border-mid bg-apex-surface animate-pulse`} aria-hidden="true" />}>
        <CourseMap key={course.key} points={Array.isArray(course.points) ? course.points : null} km={course.km} height={height} />
      </Suspense>

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

      {download && course.gpxUrl && <a href={course.gpxUrl} download className={secondaryBtn}>Pobierz GPX</a>}
    </div>
  )
}
