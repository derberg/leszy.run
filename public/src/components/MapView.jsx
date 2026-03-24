import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import useTheme from '../hooks/useTheme.js'

const defaultPin = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
})

const POLAND_CENTER = [52.0, 19.5]
const POLAND_ZOOM = 6

export default function MapView({ events }) {
  const mappable = events.filter(e => e.lat && e.lng)
  const { isDark } = useTheme()

  const tileUrl = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

  return (
    <div className="max-w-[1200px] mx-auto px-6 pb-16">
      <MapContainer
        center={POLAND_CENTER}
        zoom={POLAND_ZOOM}
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
                {ev.registration_url && (
                  <a href={ev.registration_url} target="_blank" rel="noopener">Zapisy &rarr;</a>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}
