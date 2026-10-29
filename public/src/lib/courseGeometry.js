// Course drawing helpers for RA1b (Trasa): km markers along the GPX track and
// the elevation profile as SVG paths. Pure; the track is course.points
// ([[lat, lng]], downsampled by parseGpx) and the profile course.profile
// ([[km, elevation m]]).
import { haversineKm } from './haversine.js'

/** Marker spacing that keeps a course readable: 1, 2, 5 or 10 km. */
export function markerStepKm(totalKm) {
  if (totalKm <= 5) return 1
  if (totalKm <= 15) return 2
  if (totalKm <= 30) return 5
  return 10
}

/** [{ km, lat, lng }] every `stepKm` along the track, interpolated between points; never the start or the end. */
export function kmMarkers(points, stepKm) {
  if (!Array.isArray(points) || points.length < 2 || !(stepKm > 0)) return []
  const out = []
  let done = 0
  let next = stepKm
  for (let i = 1; i < points.length; i++) {
    const [aLat, aLng] = points[i - 1]
    const [bLat, bLng] = points[i]
    const seg = haversineKm(aLat, aLng, bLat, bLng)
    while (seg > 0 && done + seg >= next) {
      const t = (next - done) / seg
      out.push({ km: next, lat: aLat + (bLat - aLat) * t, lng: aLng + (bLng - aLng) * t })
      next += stepKm
    }
    done += seg
  }
  // A marker on the very end would sit on the finish marker.
  return out.filter((m) => done - m.km > stepKm * 0.25)
}

/** Start and finish within 300 m (one marker at any course zoom): one „START / META” marker. */
export function isLoop(points) {
  if (!Array.isArray(points) || points.length < 2) return false
  const [a, b] = [points[0], points.at(-1)]
  return haversineKm(a[0], a[1], b[0], b[1]) <= 0.3
}

const r2 = (n) => Math.round(n * 100) / 100
const kmText = (km) => String(Number(km.toFixed(1))).replace('.', ',')

/**
 * The elevation profile scaled into a width × height box. The line runs from
 * y = pad (highest) to y = height − 2·pad (lowest); the bottom band holds the
 * km labels. → { line, area, ticks: [{ x, label }], minEle, maxEle } or null.
 */
export function profileShape(profile, { width, height, pad = 14 }) {
  if (!Array.isArray(profile) || profile.length < 2) return null
  const maxKm = profile.at(-1)[0] || 1
  const eles = profile.map((p) => p[1])
  const minEle = Math.min(...eles)
  const maxEle = Math.max(...eles)
  const top = pad
  const bottom = height - 2 * pad
  const y = (e) => (maxEle === minEle ? (top + bottom) / 2 : top + ((maxEle - e) / (maxEle - minEle)) * (bottom - top))
  const pts = profile.map(([km, e]) => `${r2((km / maxKm) * width)} ${r2(y(e))}`)
  const line = `M${pts.join(' L')}`
  return {
    line,
    area: `${line} L${width} ${height} L0 ${height} Z`,
    ticks: [
      { x: 0, label: '0' },
      { x: width / 2, label: kmText(maxKm / 2) },
      { x: width, label: `${kmText(maxKm)} km` },
    ],
    minEle,
    maxEle,
  }
}
