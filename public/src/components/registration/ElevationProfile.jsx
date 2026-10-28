import { profileShape } from '../../lib/courseGeometry.js'

// RA1b „Profil”: elevation along the course (course.profile, [[km, m]]) as an
// inline SVG that scales with the page width.
const W = 600
const H = 120

export default function ElevationProfile({ profile }) {
  const s = profileShape(profile, { width: W, height: H, pad: 16 })
  if (!s) return null
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block border border-apex-border bg-apex-surface" role="img"
      aria-label={`Profil wysokości: od ${s.minEle} do ${s.maxEle} m n.p.m.`} data-testid="elevation-profile">
      <path d={s.area} fill="var(--color-apex-surface-3)" />
      <path d={s.line} fill="none" stroke="var(--color-apex-yellow)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {s.ticks.map((t, i) => (
        <text key={t.label} x={i === 0 ? 4 : i === 2 ? W - 4 : t.x} y={H - 6} fill="var(--color-apex-muted)"
          fontFamily="'IBM Plex Mono', monospace" fontSize="13" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
          {t.label}
        </text>
      ))}
    </svg>
  )
}
