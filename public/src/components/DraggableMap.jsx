import { useRef, useEffect } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const markerIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  shadowSize: [41, 41],
})

function DraggablePin({ position, onMove }) {
  const markerRef = useRef(null)

  useMapEvents({
    click(e) {
      onMove(e.latlng.lat, e.latlng.lng)
    },
  })

  return (
    <Marker
      position={position}
      icon={markerIcon}
      draggable
      ref={markerRef}
      eventHandlers={{
        dragend() {
          const m = markerRef.current
          if (m) {
            const { lat, lng } = m.getLatLng()
            onMove(lat, lng)
          }
        },
      }}
    />
  )
}

function RecenterMap({ lat, lng }) {
  const map = useMapEvents({})
  const prevRef = useRef(null)

  useEffect(() => {
    const key = `${lat},${lng}`
    if (lat && lng && key !== prevRef.current) {
      prevRef.current = key
      map.setView([lat, lng], map.getZoom())
    }
  }, [lat, lng, map])

  return null
}

/**
 * Leaflet map with a draggable pin. User can click or drag to set position.
 *
 * @param {{ lat: number|null, lng: number|null, onChange: (lat: number, lng: number) => void, height?: number }} props
 */
export default function DraggableMap({ lat, lng, onChange, height = 180 }) {
  const hasCoords = lat != null && lng != null
  const center = hasCoords ? [Number(lat), Number(lng)] : [52.0, 19.5]
  const zoom = hasCoords ? 13 : 6

  return (
    <div>
      <div className="border border-apex-border overflow-hidden relative" style={{ height }}>
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom={true}
          style={{ height: '100%', width: '100%' }}
          attributionControl={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <RecenterMap lat={lat} lng={lng} />
          {hasCoords && (
            <DraggablePin
              position={[Number(lat), Number(lng)]}
              onMove={(newLat, newLng) => onChange(newLat, newLng)}
            />
          )}
        </MapContainer>
        {hasCoords && (
          <div className="absolute bottom-1.5 right-2 font-mono text-[10px] text-apex-yellow bg-apex-bg/80 px-1.5 py-0.5 z-[1000] pointer-events-none">
            {Number(lat).toFixed(4)}°N, {Number(lng).toFixed(4)}°E
          </div>
        )}
      </div>
      <div className="font-mono text-[10px] text-apex-muted mt-1">
        {hasCoords ? 'Kliknij lub przesuń pinezkę, aby skorygować lokalizację' : 'Podaj miasto, aby zobaczyć mapę'}
      </div>
    </div>
  )
}
