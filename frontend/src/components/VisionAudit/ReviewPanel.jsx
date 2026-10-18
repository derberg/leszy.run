import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card.jsx'
import { Button } from '../ui/button.jsx'
import { Input } from '../ui/input.jsx'
import { Badge } from '../ui/badge.jsx'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody,
} from '../ui/dialog.jsx'
import { ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react'

const VERDICTS = {
  visible: { text: 'Numer widoczny', cls: 'border-green-700 text-green-400' },
  covered: { text: 'Numer zasłonięty', cls: 'border-apex-yellow text-apex-yellow' },
  no_front: { text: 'Brak numeru z przodu', cls: 'border-apex-yellow text-apex-yellow' },
  absent: { text: 'Nie ma na zdjęciach', cls: 'border-apex-border-mid text-apex-muted' },
}

function clockTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function ReviewPanel({ sessionId }) {
  const [filter, setFilter] = useState('unread')
  const [openIndex, setOpenIndex] = useState(null)

  const { data: page } = useQuery({
    queryKey: ['vision-review', sessionId, filter],
    queryFn: () => api.vision.review(sessionId, filter),
  })
  const rows = page?.data ?? []
  const open = openIndex != null ? rows[openIndex] : null

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Weryfikacja</CardTitle>
        <div className="flex flex-wrap items-center gap-3">
          {page && (
            <span className="font-mono text-xs text-apex-muted">
              kamera odczytała {page.read} z {page.total} · zweryfikowano {page.reviewed}
            </span>
          )}
          {[['unread', 'Nieodczytani'], ['all', 'Wszyscy']].map(([key, text]) => (
            <button
              key={key}
              onClick={() => { setFilter(key); setOpenIndex(null) }}
              className={`border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${
                filter === key
                  ? 'border-apex-yellow text-apex-yellow'
                  : 'border-apex-border text-apex-muted hover:border-apex-border-mid'
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0
          ? <p className="px-4 py-8 text-center text-sm text-apex-muted">Brak zawodników do weryfikacji.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-apex-border text-[10px] uppercase tracking-widest text-apex-muted">
                    <th className="px-3 py-2 text-left font-bold">Meta (chip)</th>
                    <th className="px-3 py-2 text-left font-bold">Numer</th>
                    <th className="px-3 py-2 text-left font-bold">Zawodnik</th>
                    <th className="px-3 py-2 text-left font-bold">Kategoria</th>
                    <th className="px-3 py-2 text-left font-bold">Kamera</th>
                    <th className="px-3 py-2 text-left font-bold">Weryfikacja</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.participantId} className="border-b border-apex-border/50 hover:bg-apex-surface-2">
                      <td className="px-3 py-2 font-mono text-xs text-apex-muted whitespace-nowrap">{clockTime(r.finishTime)}</td>
                      <td className="px-3 py-2 font-mono text-base text-apex-text-bright">{r.bibNumber}</td>
                      <td className="px-3 py-2 text-xs text-apex-text">{`${r.firstName ?? ''} ${r.lastName ?? ''}`.trim()}</td>
                      <td className="px-3 py-2 text-xs text-apex-muted">{r.category}</td>
                      <td className="px-3 py-2">
                        {r.cameraRead
                          ? <Badge className="border-green-700 text-green-400">Odczytany</Badge>
                          : <Badge className="border-apex-border-mid text-apex-muted">Brak</Badge>}
                      </td>
                      <td className="px-3 py-2">
                        {r.verdict
                          ? <Badge className={VERDICTS[r.verdict].cls}>
                              {VERDICTS[r.verdict].text}{r.verdict === 'visible' ? ` ${r.reviewBib}` : ''}
                            </Badge>
                          : <span className="text-xs text-apex-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setOpenIndex(i)}
                          title="Pokaż zdjęcia z mety"
                          className="text-apex-muted hover:text-apex-yellow transition-colors"
                        >
                          <ImageIcon size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardContent>

      {open && (
        <ReviewDialog
          key={open.participantId}
          sessionId={sessionId}
          row={open}
          onClose={() => setOpenIndex(null)}
          onNext={() => setOpenIndex(i => (i + 1 < rows.length ? i + 1 : null))}
        />
      )}
    </Card>
  )
}

// Full frames show faces, so they open only on an explicit click, as in the
// pass viewer. A click on the runner marks where they are; with "Numer
// widoczny" that point and frame become a training label.
function ReviewDialog({ sessionId, row, onClose, onNext }) {
  const qc = useQueryClient()
  const { data: frames = [], isLoading } = useQuery({
    queryKey: ['vision-review-frames', sessionId, row.participantId],
    queryFn: () => api.vision.reviewFrames(sessionId, row.participantId),
  })
  const [index, setIndex] = useState(0)
  const [point, setPoint] = useState(
    row.verdict === 'visible' && row.reviewFrameTs != null
      ? { ts: String(row.reviewFrameTs), x: row.reviewX, y: row.reviewY }
      : null,
  )
  const [bib, setBib] = useState(row.reviewBib ?? row.bibNumber ?? '')
  const placed = useRef(false)

  // Open on the marked frame if there is one, else one second before the
  // chip time, where the runner is usually facing the camera.
  useEffect(() => {
    if (placed.current || frames.length === 0) return
    placed.current = true
    const marked = point ? frames.indexOf(point.ts) : -1
    setIndex(marked >= 0 ? marked : Math.max(0, frames.length - 1 - 10))
  }, [frames, point])

  const save = useMutation({
    mutationFn: (body) => body
      ? api.vision.setReview(sessionId, row.participantId, body)
      : api.vision.clearReview(sessionId, row.participantId),
    onSuccess: (_, body) => {
      qc.invalidateQueries({ queryKey: ['vision-review', sessionId] })
      if (body) onNext()
    },
  })

  const ts = frames[index]
  const step = (delta) => setIndex(i => Math.min(frames.length - 1, Math.max(0, i + delta)))

  function mark(e) {
    const r = e.currentTarget.getBoundingClientRect()
    setPoint({ ts, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-5xl"
        onKeyDown={(e) => {
          if (e.target.tagName === 'INPUT') return
          if (e.key === 'ArrowLeft') step(-1)
          if (e.key === 'ArrowRight') step(1)
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {row.bibNumber} · {`${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()} · meta {clockTime(row.finishTime)}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {isLoading && <div className="aspect-video w-full animate-pulse bg-apex-surface-2" />}
          {!isLoading && frames.length === 0 && (
            <p className="py-8 text-center text-sm text-apex-muted">Brak klatek z chwili mety.</p>
          )}
          {ts && (
            <div className="relative cursor-crosshair" onClick={mark}>
              <img
                src={api.vision.frameUrl(sessionId, ts)}
                alt=""
                className="w-full border border-apex-border bg-apex-bg"
                draggable={false}
              />
              {point && point.ts === ts && (
                <span
                  className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-apex-yellow"
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                />
              )}
            </div>
          )}
          {frames.length > 1 && (
            <div className="flex items-center justify-between gap-3">
              <Button size="sm" variant="outline" onClick={() => step(-1)} disabled={index === 0}>
                <ChevronLeft size={14} />
              </Button>
              <input
                type="range" min={0} max={frames.length - 1} value={index}
                onChange={e => setIndex(Number(e.target.value))}
                className="flex-1 accent-apex-yellow"
              />
              <span className="font-mono text-xs text-apex-muted">{index + 1} / {frames.length}</span>
              <Button size="sm" variant="outline" onClick={() => step(1)} disabled={index === frames.length - 1}>
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
          {ts && (
            <p className={`text-xs ${point ? 'text-apex-muted' : 'text-apex-yellow'}`}>
              {point ? 'Zawodnik zaznaczony.' : 'Kliknij zawodnika na zdjęciu, żeby zapisać „Numer widoczny”.'}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={bib}
              onChange={e => setBib(e.target.value)}
              className="w-20 font-mono"
              aria-label="Numer na zdjęciu"
            />
            <Button
              size="sm"
              disabled={!point || !bib || save.isPending}
              title={point ? undefined : 'Kliknij zawodnika na zdjęciu'}
              onClick={() => save.mutate({ verdict: 'visible', bibNumber: bib, frameTs: point.ts, x: point.x, y: point.y })}
            >
              Numer widoczny
            </Button>
            {['covered', 'no_front', 'absent'].map(v => (
              <Button key={v} size="sm" variant="outline" disabled={save.isPending}
                onClick={() => save.mutate({ verdict: v })}>
                {VERDICTS[v].text}
              </Button>
            ))}
            {row.verdict && (
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
                Wyczyść
              </Button>
            )}
          </div>
          {save.error && <p className="text-xs text-apex-red">{save.error.message}</p>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
