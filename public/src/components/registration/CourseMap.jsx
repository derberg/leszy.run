import { useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { isLoop, kmMarkers, markerStepKm } from '../../lib/courseGeometry.js'
import useTheme from '../../hooks/useTheme.js'

// RA1b: the course from its GPX (course.points, [[lat, lng]]) on OpenStreetMap:
// the line, a START / META marker (one for a loop, two otherwise) and a label
// every 1, 2, 5 or 10 km. Tiles only, no browser permission needed.

// Leaflet writes these as SVG attributes, where a CSS variable is not reliable.
const LINE = '#BBDD00'
const LINE_LIGHT = '#6B8000'

function kmIcon(km) {
  return L.divIcon({
    className: '',
    html: `<span style="display:block;transform:translate(-50%,-50%);font:500 11px 'IBM Plex Mono',monospace;color:#DDDCEC;background:#0A0A10;border:1px solid #343450;padding:0 3px;line-height:16px">${km}</span>`,
    iconSize: [0, 0],
  })
}

function EndMarker({ position, label, color }) {
  return (
    <CircleMarker center={position} radius={8} pathOptions={{ color, weight: 3, fillColor: '#0A0A10', fillOpacity: 1 }}>
      <Tooltip permanent direction="auto" offset={[10, 0]} className="leszy-course-label">{label}</Tooltip>
    </CircleMarker>
  )
}

export default function CourseMap({ points, km }) {
  const { isDark } = useTheme()
  const color = isDark ? LINE : LINE_LIGHT
  const markers = useMemo(() => kmMarkers(points, markerStepKm(km ?? 0)), [points, km])
  if (!Array.isArray(points) || points.length < 2) return null
  const bounds = L.latLngBounds(points)
  const start = points[0]
  const finish = points.at(-1)
  const loop = isLoop(points)
  return (
    <div className={`relative h-[360px] md:h-[440px] border border-apex-border-mid overflow-hidden ${isDark ? 'map-dark' : ''}`} data-testid="course-map">
      <MapContainer bounds={bounds} boundsOptions={{ paddingTopLeft: [40, 32], paddingBottomRight: [40, 32] }} scrollWheelZoom={false} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline positions={points} pathOptions={{ color, weight: 4, lineJoin: 'round' }} />
        {markers.map((m) => <Marker key={m.km} position={[m.lat, m.lng]} icon={kmIcon(m.km)} interactive={false} />)}
        {loop
          ? <EndMarker position={start} label="START / META" color={color} />
          : (<><EndMarker position={start} label="START" color={color} /><EndMarker position={finish} label="META" color={color} /></>)}
      </MapContainer>
    </div>
  )
}
