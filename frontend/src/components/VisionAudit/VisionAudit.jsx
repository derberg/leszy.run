import { useState, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { useWsEvent } from '../../lib/ws.js'
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card.jsx'
import { Button } from '../ui/button.jsx'
import { Input } from '../ui/input.jsx'
import { Badge } from '../ui/badge.jsx'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody,
} from '../ui/dialog.jsx'
import {
  Camera, CameraOff, AlertTriangle, CheckCircle2, HelpCircle, Play, Square,
  Trash2, Image as ImageIcon, Info,
} from 'lucide-react'

const DEFAULT_QUEUE_DIR = '/mnt/ssd/frames'

const VERDICT_STYLE = {
  ok:      { cls: 'border-green-700 text-green-400',   Icon: CheckCircle2 },
  warn:    { cls: 'border-apex-yellow text-apex-yellow', Icon: AlertTriangle },
  error:   { cls: 'border-apex-red text-apex-red',       Icon: CameraOff },
  unknown: { cls: 'border-apex-border-mid text-apex-muted', Icon: HelpCircle },
}

const FILTERS = [
  ['all', 'Wszystkie'],
  ['matched', 'Rozpoznane w rosterze'],
  ['unmatched', 'Spoza rosteru'],
  ['unreadable', 'Nieodczytane'],
]

function pct(value) {
  return `${(value * 100).toFixed(1)}%`
}

function clockTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('pl-PL', { hour12: false })
}

export default function VisionAudit({ eventId }) {
  const qc = useQueryClient()
  const [sessionId, setSessionId] = useState(null)

  const { data: sessions = [] } = useQuery({
    queryKey: ['vision-sessions', eventId],
    queryFn: () => api.vision.sessions(eventId),
    refetchInterval: 15000,
  })

  // Pick the newest running session by default, so opening the tab on race
  // morning already shows the camera rather than an empty chooser.
  const active = useMemo(
    () => sessions.find(s => s.id === sessionId)
      ?? sessions.find(s => !s.stoppedAt)
      ?? sessions[0]
      ?? null,
    [sessions, sessionId],
  )

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['vision-sessions', eventId] })
    if (active) {
      qc.invalidateQueries({ queryKey: ['vision-session', active.id] })
      qc.invalidateQueries({ queryKey: ['vision-sightings', active.id] })
    }
  }, [qc, eventId, active])

  return (
    <div className="space-y-4">
      <NotTimingNotice />
      <SessionBar
        eventId={eventId}
        sessions={sessions}
        active={active}
        onPick={setSessionId}
        onChanged={refresh}
      />
      {active
        ? <SessionView session={active} />
        : <NoSession />}
    </div>
  )
}

// ─── the standing caveat ────────────────────────────────────────────────────
// The parent spec rules live reading out of scope because the Pi has no
// accelerator. A throttled diagnostic view is a different claim, and the only
// way that stays honest is to say so where it cannot be missed.

function NotTimingNotice() {
  return (
    <div className="border border-apex-border-mid bg-apex-surface-2 px-4 py-3 flex items-start gap-3">
      <Info size={16} className="text-apex-muted shrink-0 mt-0.5" />
      <p className="text-xs text-apex-muted leading-relaxed">
        <span className="font-bold uppercase tracking-widest text-apex-text">Podgląd diagnostyczny.</span>{' '}
        Odczyt z kamery jest celowo spowolniony i <span className="text-apex-text">nie służy do pomiaru czasu</span> —
        czas liczy chip. Ten ekran odpowiada na jedno pytanie: czy kamera działa, jest dobrze
        ustawiona i czyta numery. Zdjęcia nie opuszczają tego komputera.
      </p>
    </div>
  )
}

function NoSession() {
  return (
    <Card>
      <CardContent className="py-10 text-center space-y-2">
        <Camera size={28} className="mx-auto text-apex-muted" />
        <p className="text-sm text-apex-muted">Brak sesji kamery dla tego wydarzenia.</p>
        <p className="text-xs text-apex-muted">
          Uruchom na Pi <span className="font-mono text-apex-text">capture.py</span> i{' '}
          <span className="font-mono text-apex-text">read_queue.py</span>, potem dodaj katalog kolejki powyżej.
        </p>
      </CardContent>
    </Card>
  )
}

// ─── session chooser + start/stop ───────────────────────────────────────────

function SessionBar({ eventId, sessions, active, onPick, onChanged }) {
  const [queueDir, setQueueDir] = useState(DEFAULT_QUEUE_DIR)
  const [label, setLabel] = useState('')
  const [error, setError] = useState(null)

  const create = useMutation({
    mutationFn: () => api.vision.createSession(eventId, { queueDir, label: label || null }),
    onSuccess: (row) => { setError(null); setLabel(''); onPick(row.id); onChanged() },
    onError: (err) => setError(err.message),
  })
  const stop = useMutation({
    mutationFn: (id) => api.vision.stop(id), onSuccess: onChanged,
  })
  const resume = useMutation({
    mutationFn: (id) => api.vision.resume(id), onSuccess: onChanged,
  })
  const remove = useMutation({
    mutationFn: (id) => api.vision.deleteSession(id),
    onSuccess: () => { onPick(null); onChanged() },
  })

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Sesja kamery</CardTitle>
        {active && (
          <div className="flex items-center gap-2">
            {active.stoppedAt
              ? (
                <Button size="sm" onClick={() => resume.mutate(active.id)} disabled={resume.isPending}>
                  <Play size={13} className="mr-1.5" />Wznów
                </Button>
              )
              : (
                <Button size="sm" variant="outline" onClick={() => stop.mutate(active.id)} disabled={stop.isPending}>
                  <Square size={13} className="mr-1.5" />Zatrzymaj
                </Button>
              )}
            <Button
              size="sm"
              variant="outline"
              className="border-apex-red/50 text-apex-red hover:border-apex-red"
              onClick={() => {
                if (confirm('Usunąć sesję z listy? Klatki i wycinki na dysku zostają nietknięte.')) {
                  remove.mutate(active.id)
                }
              }}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {sessions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {sessions.map(s => (
              <button
                key={s.id}
                onClick={() => onPick(s.id)}
                className={`border px-3 py-1.5 text-xs font-mono transition-colors ${
                  active?.id === s.id
                    ? 'border-apex-yellow text-apex-yellow'
                    : 'border-apex-border text-apex-muted hover:border-apex-border-mid'
                }`}
              >
                {s.label || s.queueDir.split('/').pop()}
                <span className="ml-2 opacity-60">{clockTime(s.startedAt)}</span>
                {!s.stoppedAt && <span className="ml-2 text-green-400">●</span>}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[16rem]">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-apex-muted mb-1">
              Katalog kolejki na Pi
            </label>
            <Input
              value={queueDir}
              onChange={e => setQueueDir(e.target.value)}
              placeholder={DEFAULT_QUEUE_DIR}
              className="font-mono text-xs"
            />
          </div>
          <div className="w-40">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-apex-muted mb-1">
              Nazwa (opcjonalnie)
            </label>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="meta" className="text-xs" />
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !queueDir}>
            <Play size={13} className="mr-1.5" />Obserwuj
          </Button>
        </div>
        {error && <p className="text-xs text-apex-red">{error}</p>}
      </CardContent>
    </Card>
  )
}

// ─── one session: health, stats, reads ──────────────────────────────────────

function SessionView({ session }) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState('all')
  const [bib, setBib] = useState('')
  const [frameOf, setFrameOf] = useState(null)

  const { data: detail } = useQuery({
    queryKey: ['vision-session', session.id],
    queryFn: () => api.vision.session(session.id),
    refetchInterval: 5000,
  })

  const { data: sightings = [] } = useQuery({
    queryKey: ['vision-sightings', session.id, filter, bib],
    queryFn: () => api.vision.sightings(session.id, { filter, bib: bib || undefined }),
    refetchInterval: 5000,
  })

  // A new read arriving pushes the list rather than waiting for the poll, so
  // walking a volunteer past the camera gives immediate feedback.
  useWsEvent('vision:sighting', useCallback((row) => {
    if (row?.sessionId !== session.id) return
    qc.invalidateQueries({ queryKey: ['vision-sightings', session.id] })
    qc.invalidateQueries({ queryKey: ['vision-session', session.id] })
  }, [qc, session.id]))

  useWsEvent('vision:health', useCallback((payload) => {
    if (payload?.sessionId !== session.id) return
    qc.setQueryData(['vision-session', session.id], (prev) =>
      prev ? { ...prev, health: payload.health, verdict: payload.verdict } : prev)
  }, [qc, session.id]))

  const health = detail?.health ?? null
  const verdict = detail?.verdict ?? session.verdict
  const stats = detail?.stats

  return (
    <div className="space-y-4">
      <HealthStrip verdict={verdict} health={health} session={detail ?? session} />
      {stats && <Stats stats={stats} />}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Odczyty</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map(([key, text]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${
                  filter === key
                    ? 'border-apex-yellow text-apex-yellow'
                    : 'border-apex-border text-apex-muted hover:border-apex-border-mid'
                }`}
              >
                {text}
              </button>
            ))}
            <Input
              value={bib}
              onChange={e => setBib(e.target.value)}
              placeholder="nr"
              className="w-20 text-xs font-mono"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <SightingTable
            sightings={sightings}
            sessionId={session.id}
            onOpenFrame={setFrameOf}
          />
        </CardContent>
      </Card>

      <FrameDialog
        sighting={frameOf}
        sessionId={session.id}
        onClose={() => setFrameOf(null)}
      />
    </div>
  )
}

// ─── health ─────────────────────────────────────────────────────────────────

function HealthStrip({ verdict, health, session }) {
  const style = VERDICT_STYLE[verdict?.level ?? 'unknown']
  const { Icon } = style

  return (
    <div className={`border-2 ${style.cls} bg-apex-surface`}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon size={22} className="shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-bold uppercase tracking-widest">{verdict?.headline ?? '—'}</p>
          {verdict?.detail && <p className="text-xs text-apex-muted mt-1">{verdict.detail}</p>}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border-t border-apex-border divide-x divide-apex-border">
        <Metric label="Ostatnia klatka" value={health ? `${health.last_frame_age_s}s` : '—'} />
        <Metric label="Zaległość" value={health ? health.pending : '—'} />
        <Metric label="Klatek / s (kamera)" value={health ? health.capture_fps : '—'} />
        <Metric label="Klatek / s (odczyt)" value={health ? health.reader_fps : '—'} />
        <Metric
          label="Jasność"
          value={health ? health.mean_luminance : '—'}
          tone={health?.exposure === 'ok' ? null : 'warn'}
        />
        <Metric
          label="Uszkodzone"
          value={health ? health.torn_frames : '—'}
          tone={health?.torn_frames > 0 ? 'warn' : null}
        />
      </div>
      <div className="border-t border-apex-border px-4 py-2 flex flex-wrap gap-x-6 gap-y-1 text-[10px] font-mono text-apex-muted">
        <span>{session.queueDir}</span>
        <span>zegar: {health?.clock_synced === false ? 'NIE ZSYNCHRONIZOWANY' : health?.clock_synced === true ? 'ok' : '—'}</span>
        <span>przetworzone: {health?.processed ?? '—'}</span>
        <span>{health?.ms_per_frame != null ? `${health.ms_per_frame} ms/klatkę` : ''}</span>
      </div>
    </div>
  )
}

function Metric({ label, value, tone }) {
  return (
    <div className="px-3 py-2">
      <p className="text-[9px] font-bold uppercase tracking-widest text-apex-muted">{label}</p>
      <p className={`font-mono text-lg ${tone === 'warn' ? 'text-apex-yellow' : 'text-apex-text-bright'}`}>
        {value}
      </p>
    </div>
  )
}

// ─── stats ──────────────────────────────────────────────────────────────────

function Stats({ stats }) {
  const buckets = Object.entries(stats.framesPerTrack)
  const maxBucket = Math.max(1, ...buckets.map(([, n]) => n))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle>Jakość odczytu</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Stat
            label="Skuteczność rozpoznania"
            value={pct(stats.recognitionRate)}
            hint={`${stats.recognised} z ${stats.total} przejść dało numer`}
          />
          <Stat
            label="Trafienia w roster"
            value={pct(stats.rosterMatchRate)}
            hint={`${stats.rosterMatched} z ${stats.recognised} rozpoznanych numerów istnieje w tym biegu`}
            tone={stats.recognised > 0 && stats.rosterMatchRate < 0.9 ? 'warn' : null}
          />
          <Stat
            label="Średnia pewność"
            value={stats.meanConfidence.toFixed(2)}
            hint="tylko rozpoznane przejścia"
          />
          <Stat
            label="Nieodczytane"
            value={stats.unreadable}
            hint="ktoś przebiegł, numeru nie dało się odczytać"
          />
          {/* The distinction that keeps this screen honest. */}
          <p className="text-[10px] text-apex-muted leading-relaxed border-t border-apex-border pt-2">
            To <span className="text-apex-text">nie jest</span> read rate. Read rate mierzy się
            względem numerów, które zawodnicy naprawdę mieli — tego ten ekran nie wie.
            „Trafienia w roster” to najlepszy dostępny sygnał jakości: numer spoza rosteru
            to prawie zawsze błędny odczyt.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Klatek na zawodnika</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {buckets.map(([label, n]) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-12 font-mono text-xs text-apex-muted">{label}</span>
              <div className="flex-1 h-4 bg-apex-surface-2 border border-apex-border">
                <div
                  className={`h-full ${label === '1-4' && n > 0 ? 'bg-apex-red/60' : 'bg-apex-yellow/60'}`}
                  style={{ width: `${(n / maxBucket) * 100}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono text-xs text-apex-text">{n}</span>
            </div>
          ))}
          <p className="text-[10px] text-apex-muted leading-relaxed border-t border-apex-border pt-2">
            Kamera skierowana wzdłuż bieżni daje ok. 30 klatek na zawodnika i jedna zła klatka
            zostaje przegłosowana. Skupisko w „1-4” znaczy, że kamera patrzy w poprzek —
            cztery klatki nie przegłosują jednej złej. To problem ustawienia, nie modelu.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value, hint, tone }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-apex-muted">{label}</span>
        <span className={`font-mono text-xl ${tone === 'warn' ? 'text-apex-yellow' : 'text-apex-text-bright'}`}>
          {value}
        </span>
      </div>
      {hint && <p className="text-[10px] text-apex-muted">{hint}</p>}
    </div>
  )
}

// ─── the read list ──────────────────────────────────────────────────────────

function SightingTable({ sightings, sessionId, onOpenFrame }) {
  if (!sightings.length) {
    return <p className="px-4 py-8 text-center text-sm text-apex-muted">Brak odczytów.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-apex-border text-[10px] uppercase tracking-widest text-apex-muted">
            <th className="px-3 py-2 text-left font-bold">Czas</th>
            <th className="px-3 py-2 text-left font-bold">Wycinek</th>
            <th className="px-3 py-2 text-left font-bold">Numer</th>
            <th className="px-3 py-2 text-left font-bold">Zawodnik</th>
            <th className="px-3 py-2 text-right font-bold">Pewność</th>
            <th className="px-3 py-2 text-right font-bold">Klatek</th>
            <th className="px-3 py-2 text-left font-bold">Wynik</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {sightings.map(s => (
            <SightingRow key={s.id} s={s} sessionId={sessionId} onOpenFrame={onOpenFrame} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SightingRow({ s, sessionId, onOpenFrame }) {
  const unreadable = s.bibNumber == null
  const unmatched = !unreadable && s.participantId == null

  return (
    <tr className="border-b border-apex-border/50 hover:bg-apex-surface-2">
      <td className="px-3 py-2 font-mono text-xs text-apex-muted whitespace-nowrap">
        {clockTime(s.sightedAt)}
      </td>
      <td className="px-3 py-2">
        {s.cropName
          ? (
            <img
              src={api.vision.cropUrl(sessionId, s.cropName)}
              alt=""
              className="h-8 border border-apex-border bg-apex-bg"
              loading="lazy"
            />
          )
          : <span className="text-apex-muted text-xs">—</span>}
      </td>
      <td className="px-3 py-2 font-mono text-base text-apex-text-bright">
        {s.bibNumber ?? <span className="text-apex-muted text-sm">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-apex-text">
        {s.lastName ? `${s.firstName ?? ''} ${s.lastName}`.trim() : <span className="text-apex-muted">—</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-apex-text">
        {s.bibNumber != null ? Number(s.confidence).toFixed(2) : '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-apex-muted">{s.frameCount}</td>
      <td className="px-3 py-2">
        {unreadable && (
          <Badge className="border-apex-border-mid text-apex-muted">Nieodczytany</Badge>
        )}
        {unmatched && (
          <Badge className="border-apex-red text-apex-red">Spoza rosteru</Badge>
        )}
        {!unreadable && !unmatched && (
          <Badge className="border-green-700 text-green-400">OK</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {s.bestFrameTs != null && (
          <button
            onClick={() => onOpenFrame(s)}
            title="Pokaż pełną klatkę"
            className="text-apex-muted hover:text-apex-yellow transition-colors"
          >
            <ImageIcon size={14} />
          </button>
        )}
      </td>
    </tr>
  )
}

// ─── full frame ─────────────────────────────────────────────────────────────
// Behind an explicit click, never in the list. Unlike the crop, a full frame
// shows a whole person and a face.

function FrameDialog({ sighting, sessionId, onClose }) {
  if (!sighting) return null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            Pełna klatka — {sighting.bibNumber ?? 'nieodczytany'} · {clockTime(sighting.sightedAt)}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <img
            src={api.vision.frameUrl(sessionId, sighting.bestFrameTs)}
            alt=""
            className="w-full border border-apex-border bg-apex-bg"
          />
          <p className="mt-3 text-[10px] text-apex-muted leading-relaxed">
            Klatka jest przechowywana wyłącznie na tym komputerze i nie jest nigdzie wysyłana.
            Zawiera wizerunek — podlega retencji opisanej w rejestrze czynności przetwarzania.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
