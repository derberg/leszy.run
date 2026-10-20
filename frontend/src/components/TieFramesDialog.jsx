import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { Button } from './ui/button.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from './ui/dialog.jsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { frameWallMs, nearestFrameIndex } from '../lib/chipTie.js'

const clockMs = (ms) => {
  const d = new Date(ms)
  return `${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

// Full frames show faces, so like the camera audit's review they open only on
// an explicit click, and come from the backend on the capture machine.
export default function TieFramesDialog({ session, group, onClose }) {
  const lead = group[0]
  const { data: frames = [], isLoading } = useQuery({
    queryKey: ['vision-review-frames', session.id, lead.participantId],
    queryFn: () => api.vision.reviewFrames(session.id, lead.participantId),
  })
  const [index, setIndex] = useState(0)
  const placed = useRef(false)

  useEffect(() => {
    if (placed.current || frames.length === 0) return
    placed.current = true
    setIndex(Math.max(0, nearestFrameIndex(frames, session.clockOffset, Date.parse(lead.finishTime))))
  }, [frames, session.clockOffset, lead.finishTime])

  const ts = frames[index]
  const atMs = ts ? frameWallMs(ts, session.clockOffset) : null
  const step = (delta) => setIndex(i => Math.min(frames.length - 1, Math.max(0, i + delta)))

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-5xl"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') step(-1)
          if (e.key === 'ArrowRight') step(1)
        }}
      >
        <DialogHeader>
          <DialogTitle>Remis chipowy · {group.map(r => `#${r.participant?.bibNumber}`).join(' / ')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {isLoading && <div className="aspect-video w-full animate-pulse bg-apex-surface-2" />}
          {!isLoading && frames.length === 0 && (
            <p className="py-8 text-center text-sm text-apex-muted">Brak klatek z chwili mety.</p>
          )}
          {ts && (
            <img src={api.vision.frameUrl(session.id, ts)} alt="" className="w-full border border-apex-border bg-apex-bg" draggable={false} />
          )}
          {frames.length > 1 && (
            <div className="flex items-center justify-between gap-3">
              <Button size="sm" variant="outline" onClick={() => step(-1)} disabled={index === 0}>
                <ChevronLeft size={14} />
              </Button>
              <input
                type="range" min={0} max={frames.length - 1} value={index}
                onChange={e => setIndex(Number(e.target.value))}
                className="flex-1 accent-cyan-400"
              />
              <span className="font-mono text-xs text-apex-muted">{index + 1} / {frames.length}</span>
              <Button size="sm" variant="outline" onClick={() => step(1)} disabled={index === frames.length - 1}>
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
          {atMs != null && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
              <span className="text-apex-text-bright">Klatka {clockMs(atMs)}</span>
              {group.map(r => {
                const diff = Math.round(atMs - Date.parse(r.finishTime))
                return (
                  <span key={r.id} className="text-cyan-400">
                    #{r.participant?.bibNumber} chip {clockMs(Date.parse(r.finishTime))} ({diff >= 0 ? '+' : '−'}{Math.abs(diff)} ms)
                  </span>
                )
              })}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
