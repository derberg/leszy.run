import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const markerIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const POLAND_CENTER = [52.1, 19.4]
const POLAND_ZOOM = 6

/**
 * Multi-pin Leaflet map for landing pages.
 * @param {{ events: Array, center?: { lat: number, lng: number, zoom: number } }} props
 */
export default function LandingMap({ events, center }) {
  const positioned = (events || []).filter(e => e.lat && e.lng)
  const mapCenter = center ? [center.lat, center.lng] : POLAND_CENTER
  const mapZoom = center ? center.zoom : POLAND_ZOOM

  return (
    <div className="border border-apex-border overflow-hidden mb-4" style={{ height: 420 }}>
      <MapContainer
        center={mapCenter}
        zoom={mapZoom}
        scrollWheelZoom={false}
        style={{ height: '100%', width: '100%' }}
        attributionControl={true}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {positioned.map((e, i) => (
          <Marker
            key={e.id || `${e.lat}-${e.lng}-${i}`}
            position={[Number(e.lat), Number(e.lng)]}
            icon={markerIcon}
          >
            <Popup>
              <strong>{e.name}</strong>
              {e.location && <><br /><span>{e.location}</span></>}
              {e.date && <><br /><span>{new Date(e.date).toLocaleDateString('pl-PL')}</span></>}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}
