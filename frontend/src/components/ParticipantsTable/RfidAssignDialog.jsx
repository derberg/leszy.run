import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api.js'
import { useWsEvent } from '../../lib/ws.js'
import { Button } from '../ui/button.jsx'
import { Wifi, Signal } from 'lucide-react'

const RECENT_TTL = 5000
const MAX_TAGS = 8

export default function RfidAssignDialog({ participant, onAssign, onClose }) {
  const [tags, setTags] = useState(new Map())
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const tagsRef = useRef(tags)
  tagsRef.current = tags

  useEffect(() => {
    api.participants.startScan()
    return () => { api.participants.stopScan() }
  }, [])

  useEffect(() => {
    const iv = setInterval(() => setTags(new Map(tagsRef.current)), 500)
    return () => clearInterval(iv)
  }, [])

  useWsEvent('rfid:scan', ({ epc, rssi, antennaPort }) => {
    setTags(prev => {
      const next = new Map(prev)
      const existing = next.get(epc)
      next.set(epc, {
        rssi: existing ? Math.max(existing.rssi, rssi) : rssi,
        lastSeen: Date.now(),
        antennaPort,
        count: (existing?.count || 0) + 1,
      })
      return next
    })
  })

  const sortedTags = [...tags.entries()]
    .map(([epc, data]) => ({ epc, ...data, isRecent: Date.now() - data.lastSeen < RECENT_TTL }))
    .sort((a, b) => b.rssi - a.rssi)
    .slice(0, MAX_TAGS)

  const handleAssign = async (epc) => {
    setError(null)
    try {
      await onAssign(epc)
    } catch (err) {
      setError(err.message)
    }
  }

  const rssiBar = (rssi) => {
    const pct = Math.max(0, Math.min(100, ((rssi + 8000) / 5000) * 100))
    return pct
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-apex-surface border border-apex-border-mid w-full max-w-md shadow-xl">
        <div className="border-b border-apex-border px-5 py-4">
          <h2 className="font-display text-2xl uppercase tracking-wider">Przypisz RFID</h2>
          <p className="text-sm text-apex-muted mt-0.5">
            #{participant.bibNumber} {participant.firstName} {participant.lastName}
          </p>
        </div>

        <div className="px-5 py-4">
          <div className="flex items-center gap-2 text-sm text-apex-muted mb-3">
            <Wifi size={14} className="animate-pulse text-apex-yellow" />
            Przytrzymaj chip przy antenie — najsilniejszy sygnał pojawi się na górze
          </div>

          {sortedTags.length === 0 && (
            <div className="py-6 text-center text-apex-muted text-sm border border-dashed border-apex-border-mid">
              Oczekiwanie na odczyty chipa...
            </div>
          )}

          <div className="space-y-1.5">
            {sortedTags.map(tag => (
              <button
                key={tag.epc}
                onClick={() => setSelected(selected === tag.epc ? null : tag.epc)}
                className={`w-full flex items-center gap-3 px-3 py-2 border text-left transition-colors ${
                  selected === tag.epc
                    ? 'border-terrain-green bg-green-50'
                    : tag.isRecent
                    ? 'border-terrain-green-light bg-green-50/50 hover:bg-green-50'
                    : 'border-apex-border hover:border-apex-yellow hover:bg-apex-surface-2'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Signal size={13} className={tag.isRecent ? 'text-apex-yellow' : 'text-apex-muted'} />
                    <span className="font-mono text-sm">{tag.epc}</span>
                  </div>
                  <div className="flex items-center gap-2 pl-5">
                    <div className="flex-1 h-1.5 bg-apex-surface-3 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-terrain-green transition-all"
                        style={{ width: `${rssiBar(tag.rssi)}%` }}
                      />
                    </div>
                    <span className="text-xs text-apex-muted font-mono shrink-0">{tag.rssi} cdBm</span>
                    <span className="text-xs text-apex-muted shrink-0">×{tag.count}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {error && (
            <p className="mt-3 text-xs text-terrain-burgundy border border-red-200 bg-red-50 px-3 py-2">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-apex-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>Anuluj</Button>
          <Button
            disabled={!selected}
            onClick={() => handleAssign(selected)}
          >
            Przypisz „{selected?.slice(0, 10)}{selected?.length > 10 ? '…' : ''}"
          </Button>
        </div>
      </div>
    </div>
  )
}
