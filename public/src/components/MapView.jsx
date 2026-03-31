import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from 'react-leaflet'
import { useEffect } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import useTheme from '../hooks/useTheme.js'

function RecenterMap({ center, zoom }) {
  const map = useMap()
  useEffect(() => {
    map.setView(center, zoom)
  }, [map, center, zoom])
  return null
}

function getZoomForRadius(radiusKm) {
  if (radiusKm <= 10) return 11
  if (radiusKm <= 25) return 10
  if (radiusKm <= 50) return 9
  if (radiusKm <= 100) return 8
  if (radiusKm <= 150) return 7
  return 6
}

const defaultPin = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
})

const userPin = new L.Icon({
  iconUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="%23BBDD00" stroke="%230A0A10" stroke-width="3"/></svg>'),
  iconSize: [24, 24],
  iconAnchor: [12, 12],
})

const POLAND_CENTER = [52.0, 19.5]
const POLAND_ZOOM = 6

export default function MapView({ events, userLocation, radius }) {
  const mappable = events.filter(e => e.lat && e.lng)
  const { isDark } = useTheme()

  const tileUrl = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

  return (
    <div className="max-w-[1200px] mx-auto px-6 pb-16">
      <MapContainer
        center={userLocation ? [userLocation.lat, userLocation.lng] : POLAND_CENTER}
        zoom={userLocation ? getZoomForRadius(radius) : POLAND_ZOOM}
        className="w-full h-[500px] border border-apex-border"
        style={{ background: isDark ? '#0C0C14' : '#F5F5F8' }}
      >
        <TileLayer
          key={tileUrl}
          url={tileUrl}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
        />
        {mappable.map(ev => (
          <Marker key={ev.id} position={[Number(ev.lat), Number(ev.lng)]} icon={defaultPin}>
            <Popup>
              <div style={{ fontFamily: 'Rajdhani, sans-serif' }}>
                <strong>{ev.name}</strong><br />
                {ev.date} &middot; {ev.location}<br />
                {(ev.registration_url || ev.source_url) && (
                  <a href={ev.registration_url || ev.source_url} target="_blank" rel="noopener">Zapisy &rarr;</a>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
        {userLocation && (
          <>
            <RecenterMap center={[userLocation.lat, userLocation.lng]} zoom={getZoomForRadius(radius)} />
            <Marker position={[userLocation.lat, userLocation.lng]} icon={userPin}>
              <Popup>
                <div style={{ fontFamily: 'Rajdhani, sans-serif' }}>
                  <strong>Twoja lokalizacja</strong>
                </div>
              </Popup>
            </Marker>
            <Circle
              center={[userLocation.lat, userLocation.lng]}
              radius={radius * 1000}
              pathOptions={{
                color: '#BBDD00',
                fillColor: '#BBDD00',
                fillOpacity: 0.06,
                weight: 1.5,
              }}
            />
          </>
        )}
      </MapContainer>
    </div>
  )
}
