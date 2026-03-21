import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../../lib/api.js'
import { useWsEvent } from '../../lib/ws.js'
import { Button } from '../ui/button.jsx'
import { Wifi, Signal } from 'lucide-react'

const RECENT_TTL = 5000
const MAX_TAGS = 8
const DOMINANT_RSSI_GAP = 800  // cdBm gap to consider a tag "dominant" (8 dBm)

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

  // Buffer WS events into ref, flush to state on interval to avoid render storm
  useWsEvent('rfid:scan', useCallback(({ epc, rssi, antennaPort }) => {
    const cur = tagsRef.current
    const existing = cur.get(epc)
    cur.set(epc, {
      peakRssi: existing ? Math.max(existing.peakRssi, rssi) : rssi,
      lastRssi: rssi,
      lastSeen: Date.now(),
      antennaPort,
      count: (existing?.count || 0) + 1,
    })
  }, []))

  useEffect(() => {
    const iv = setInterval(() => setTags(new Map(tagsRef.current)), 500)
    return () => clearInterval(iv)
  }, [])

  const sortedTags = [...tags.entries()]
    .map(([epc, data]) => ({ epc, ...data, isRecent: Date.now() - data.lastSeen < RECENT_TTL }))
    .sort((a, b) => b.peakRssi - a.peakRssi)
    .slice(0, MAX_TAGS)

  // The top recent tag is "dominant" if it's significantly stronger than the rest
  const recentTags = sortedTags.filter(t => t.isRecent)
  const dominantEpc = recentTags.length >= 1
    && (recentTags.length === 1 || recentTags[0].lastRssi - recentTags[1].lastRssi > DOMINANT_RSSI_GAP)
    ? recentTags[0].epc
    : null
  const [lockedEpc, setLockedEpc] = useState(null)
  const [showAmbient, setShowAmbient] = useState(false)

  // Auto-lock when a dominant tag is detected
  useEffect(() => {
    if (dominantEpc && !lockedEpc) {
      setLockedEpc(dominantEpc)
      setSelected(dominantEpc)
    }
  }, [dominantEpc, lockedEpc])

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

          {/* Locked tag — shown prominently */}
          {lockedEpc && (() => {
            const tag = sortedTags.find(t => t.epc === lockedEpc)
            if (!tag) return null
            return (
              <div className="border-2 border-apex-yellow bg-apex-yellow/10 px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Signal size={14} className="text-apex-yellow" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-apex-yellow">Wykryty chip</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setLockedEpc(null); setSelected(null) }}
                    className="text-[10px] uppercase tracking-widest text-apex-muted hover:text-apex-text transition-colors"
                  >
                    Zmień
                  </button>
                </div>
                <div className="font-mono text-sm">{tag.epc}</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-apex-surface-3 overflow-hidden">
                    <div
                      className="h-full transition-all duration-500 bg-apex-yellow"
                      style={{ width: `${tag.isRecent ? rssiBar(tag.lastRssi) : 0}%` }}
                    />
                  </div>
                  <span className="text-xs text-apex-muted font-mono">{tag.isRecent ? `${tag.lastRssi} cdBm` : '—'}</span>
                  <span className="text-xs text-apex-muted">×{tag.count}</span>
                </div>
              </div>
            )
          })()}

          {/* Other tags — only when not locked */}
          {!lockedEpc && (
            <>
              <div className="space-y-1.5">
                {sortedTags.map(tag => (
                  <button
                    key={tag.epc}
                    onClick={() => setSelected(selected === tag.epc ? null : tag.epc)}
                    className={`w-full flex items-center gap-3 px-3 py-2 border text-left transition-colors ${
                      selected === tag.epc
                        ? 'border-apex-yellow bg-apex-yellow/10'
                        : tag.isRecent
                        ? 'border-apex-border-mid hover:border-apex-yellow hover:bg-apex-surface-2'
                        : 'border-apex-border opacity-40 hover:opacity-70 hover:bg-apex-surface-2'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Signal size={13} className={tag.isRecent ? 'text-apex-muted' : 'text-apex-muted/50'} />
                        <span className="font-mono text-sm">{tag.epc}</span>
                      </div>
                      <div className="flex items-center gap-2 pl-5">
                        <div className="flex-1 h-1.5 bg-apex-surface-3 overflow-hidden">
                          <div
                            className={`h-full transition-all duration-500 ${tag.isRecent ? 'bg-apex-muted' : 'bg-apex-muted/30'}`}
                            style={{ width: `${tag.isRecent ? rssiBar(tag.lastRssi) : 0}%` }}
                          />
                        </div>
                        <span className="text-xs text-apex-muted font-mono shrink-0">{tag.isRecent ? `${tag.lastRssi} cdBm` : '—'}</span>
                        <span className="text-xs text-apex-muted shrink-0">×{tag.count}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

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
