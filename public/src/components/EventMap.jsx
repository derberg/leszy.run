import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix default marker icon issue with bundlers (Vite/Webpack strip asset imports).
// Use unpkg CDN URLs directly.
const markerIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

/**
 * Single-pin Leaflet map for an event location.
 * Returns null if no coordinates are provided.
 *
 * @param {{ lat: number, lng: number, name?: string, location?: string }} props
 */
export default function EventMap({ lat, lng, name, location }) {
  if (!lat || !lng) return null

  const position = [Number(lat), Number(lng)]

  return (
    <div className="border border-apex-border overflow-hidden" style={{ height: 220 }}>
      <MapContainer
        center={position}
        zoom={13}
        scrollWheelZoom={false}
        style={{ height: '100%', width: '100%' }}
        attributionControl={true}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={position} icon={markerIcon}>
          {(name || location) && (
            <Popup>
              {name && <strong>{name}</strong>}
              {name && location && <br />}
              {location && <span>{location}</span>}
            </Popup>
          )}
        </Marker>
      </MapContainer>
    </div>
  )
}
