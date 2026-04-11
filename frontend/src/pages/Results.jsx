import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'
import { formatDuration, formatDateTime, statusLabel, statusColor, cn } from '../lib/utils.js'
import { Badge } from '../components/ui/badge.jsx'
import { Button } from '../components/ui/button.jsx'
import { Input } from '../components/ui/input.jsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.jsx'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select.jsx'
import { Download, ExternalLink, Info, Pencil, Upload, UserCheck } from 'lucide-react'
import { useWsEvent } from '../lib/ws.js'

const GENDER_VIEWS = [
  { key: null, label: 'Open' },
  { key: 'M', label: 'Mężczyźni' },
  { key: 'K', label: 'Kobiety' },
]

function GenderTabs({ value, onChange }) {
  return (
    <div className="flex gap-1 mb-4">
      {GENDER_VIEWS.map(v => (
        <button
          key={v.key ?? 'open'}
          onClick={() => onChange(v.key)}
          className={cn(
            'px-3 py-1.5 text-xs font-bold tracking-widest uppercase transition-colors border',
            value === v.key
              ? 'bg-apex-yellow text-apex-bg border-apex-yellow'
              : 'text-apex-muted border-apex-border hover:text-apex-text'
          )}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

function CategoryBlock({ cat, eventId }) {
  const [gender, setGender] = useState(null)
  const run = cat.raceRuns?.[0]

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text">{cat.name}</h2>
        <div className="flex items-center gap-2">
          {run && (
            <>
              <a href={api.results.exportCsv(run.id, gender)} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm"><Download size={12} /> CSV</Button>
              </a>
              <a href={api.results.exportPdf(run.id, gender)} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm"><Download size={12} /> PDF</Button>
              </a>
            </>
          )}
        </div>
      </div>

      <GenderTabs value={gender} onChange={setGender} />

      {!run ? (
        <div className="text-sm text-apex-muted py-4">Brak biegu.</div>
      ) : (
        <ResultsTable raceRunId={run.id} results={run.results || []} categoryId={cat.id} gender={gender} />
      )}
    </div>
  )
}

function ManualFinishPanel({ categories }) {
  const qc = useQueryClient()
  const [bibSearch, setBibSearch] = useState('')
  const [expanded, setExpanded] = useState(false)

  const manualFinish = useMutation({
    mutationFn: (resultId) => api.results.update(resultId, { finishTime: new Date().toISOString() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['event-results'] }),
  })

  // Gather all on-course results across all categories
  const onCourse = categories.flatMap(cat => {
    const run = cat.raceRuns?.[0]
    if (!run || (run.status !== 'active' && run.status !== 'finished')) return []
    return (run.results || [])
      .filter(r => r.status === 'started' && !r.finishTime)
      .map(r => ({ ...r, categoryName: cat.name }))
  })

  if (onCourse.length === 0) return null

  const filtered = bibSearch.trim()
    ? onCourse.filter(r => {
        const q = bibSearch.trim().toLowerCase()
        return String(r.participant?.bibNumber).includes(q)
          || r.participant?.lastName?.toLowerCase().includes(q)
          || r.participant?.firstName?.toLowerCase().includes(q)
      })
    : onCourse

  return (
    <Card className="mb-6 border-apex-yellow/30">
      <CardHeader className="py-2.5 flex flex-row items-center justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <CardTitle className="text-base flex items-center gap-2">
          <UserCheck size={16} className="text-apex-yellow" />
          Ręczna meta — {onCourse.length} na trasie
        </CardTitle>
        <span className="text-apex-muted text-xs">{expanded ? '▲' : '▼'}</span>
      </CardHeader>
      {expanded && (
        <CardContent>
          <input
            type="text"
            placeholder="Numer startowy lub nazwisko..."
            value={bibSearch}
            onChange={e => setBibSearch(e.target.value)}
            autoFocus
            className="w-full bg-apex-surface border border-apex-border text-apex-text px-3 py-2 text-sm font-mono focus:outline-none focus:border-apex-yellow mb-3"
          />
          <div className="border border-apex-border max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="py-4 text-center text-xs text-apex-muted">
                {bibSearch.trim() ? 'Brak wyników' : 'Brak zawodników na trasie'}
              </div>
            )}
            {filtered.map(r => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2 border-b border-apex-border last:border-0">
                <span className="font-mono text-apex-muted w-10 shrink-0">#{r.participant?.bibNumber}</span>
                <span className="flex-1 text-sm text-apex-text truncate">
                  {r.participant?.firstName} {r.participant?.lastName}
                </span>
                <span className="text-xs text-apex-muted shrink-0">{r.categoryName}</span>
                <button
                  className="border border-apex-yellow text-apex-yellow px-3 py-1 text-xs font-bold uppercase tracking-wider hover:bg-apex-yellow hover:text-black transition-colors disabled:opacity-50 shrink-0"
                  onClick={() => manualFinish.mutate(r.id)}
                  disabled={manualFinish.isPending}
                >
                  META
                </button>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function RaceOverview({ eventId, categories }) {
  const [search, setSearch] = useState('')
  const qc = useQueryClient()

  const { data: checkpoints = [] } = useQuery({
    queryKey: ['checkpoints', eventId],
    queryFn: () => api.checkpoints.list(eventId),
  })

  // ALL checkpoints including private (admin view)
  const sortedCps = [...checkpoints].sort((a, b) => (a.kmMarker || 0) - (b.kmMarker || 0))

  // Get all active/finished race runs + their results
  const raceRuns = categories.flatMap(c =>
    (c.raceRuns || []).filter(r => r.status === 'active' || r.status === 'finished').map(r => ({ ...r, categoryName: c.name }))
  )
  const allResults = categories.flatMap(c => {
    const run = (c.raceRuns || []).find(r => r.status === 'active' || r.status === 'finished')
    return run ? (run.results || []).map(r => ({ ...r, categoryName: c.name })) : []
  })

  // Fetch observations for all active races
  const { data: allObservations = [] } = useQuery({
    queryKey: ['all-observations', ...raceRuns.map(r => r.id)],
    queryFn: () => Promise.all(raceRuns.map(r => api.checkpoints.observationsForRace(r.id))).then(arrs => arrs.flat()),
    enabled: raceRuns.length > 0,
    refetchInterval: 5000,
  })

  useWsEvent('checkpoint:observation', () => {
    qc.invalidateQueries({ queryKey: ['all-observations'] })
    qc.invalidateQueries({ queryKey: ['event-results', eventId] })
  })

  const manualFinish = useMutation({
    mutationFn: (resultId) => api.results.update(resultId, { finishTime: new Date().toISOString() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['event-results', eventId] }),
  })

  // Build observation lookup: `${participantId}:${checkpointId}` → observedAt
  const obsLookup = {}
  for (const obs of allObservations) {
    const key = obs.participantId ? `${obs.participantId}:${obs.checkpointId}` : null
    const bibKey = obs.bibNumber != null ? `bib${obs.bibNumber}:${obs.checkpointId}` : null
    if (key) obsLookup[key] = obs.observedAt
    if (bibKey) obsLookup[bibKey] = obs.observedAt
  }

  // Only show results (started participants)
  const rows = allResults.filter(r => r.startTime || r.finishTime)

  const filtered = search.trim()
    ? rows.filter(r => {
        const q = search.trim().toLowerCase()
        return String(r.participant?.bibNumber).includes(q)
          || r.participant?.lastName?.toLowerCase().includes(q)
          || r.participant?.firstName?.toLowerCase().includes(q)
      })
    : rows

  // Sort: finished by position, then on-course by latest checkpoint (desc), then by bib
  const sorted = [...filtered].sort((a, b) => {
    if (a.finishTime && b.finishTime) return (a.position || 999) - (b.position || 999)
    if (a.finishTime && !b.finishTime) return -1
    if (!a.finishTime && b.finishTime) return 1
    // Both on course — sort by furthest checkpoint
    const aLastCp = sortedCps.findLastIndex(cp => obsLookup[`${a.participantId}:${cp.id}`])
    const bLastCp = sortedCps.findLastIndex(cp => obsLookup[`${b.participantId}:${cp.id}`])
    if (aLastCp !== bLastCp) return bLastCp - aLastCp
    return (a.participant?.bibNumber || 0) - (b.participant?.bibNumber || 0)
  })

  const onCourse = rows.filter(r => r.startTime && !r.finishTime).length
  const finished = rows.filter(r => r.finishTime).length

  const fmtTime = (iso) => {
    if (!iso) return null
    return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="font-display text-2xl uppercase tracking-wider text-apex-text-bright">Przegląd trasy</h2>
          <span className="text-xs text-apex-muted">
            Na trasie: {onCourse} · Na mecie: {finished} · Razem: {rows.length}
          </span>
        </div>
        <input
          type="text"
          placeholder="Szukaj..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-apex-surface border border-apex-border text-apex-text px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-apex-yellow w-48"
        />
      </div>
      <div className="border border-apex-border bg-apex-surface overflow-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-apex-border bg-apex-surface-2">
              <th className="text-left px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Nr</th>
              <th className="text-left px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
              <th className="text-left px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted">Kat.</th>
              <th className="text-left px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted">Start</th>
              {sortedCps.map(cp => (
                <th key={cp.id} className="text-center px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted">
                  {cp.name}
                  {cp.kmMarker && <div className="text-apex-dim font-normal">{cp.kmMarker} km</div>}
                  {cp.private && <div className="text-amber-500 font-normal text-[10px]">PRYW.</div>}
                </th>
              ))}
              <th className="text-left px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted">Meta</th>
              <th className="text-left px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-apex-muted">Czas</th>
              <th className="px-2 py-1.5 w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {sorted.map(r => {
              const p = r.participant
              const isFinished = !!r.finishTime
              return (
                <tr key={r.id} className={cn('transition-colors', isFinished ? 'bg-green-950/10' : '')}>
                  <td className="px-2 py-1.5 font-mono text-xs">{p?.bibNumber}</td>
                  <td className="px-2 py-1.5 text-xs">{p?.firstName} {p?.lastName}</td>
                  <td className="px-2 py-1.5 text-xs text-apex-muted">{r.categoryName}</td>
                  <td className="px-2 py-1.5 font-mono text-xs text-apex-muted">{fmtTime(r.startTime)}</td>
                  {sortedCps.map(cp => {
                    const t = obsLookup[`${r.participantId}:${cp.id}`]
                      || (p?.bibNumber != null && obsLookup[`bib${p.bibNumber}:${cp.id}`])
                    return (
                      <td key={cp.id} className={cn('text-center px-2 py-1.5 font-mono text-xs', t ? 'text-cyan-400' : 'text-apex-border')}>
                        {t ? fmtTime(t) : '—'}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1.5 font-mono text-xs">
                    {isFinished
                      ? <span className="text-green-400">{fmtTime(r.finishTime)}</span>
                      : <span className="text-apex-muted">—</span>}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs font-semibold">
                    {r.durationMs ? formatDuration(r.durationMs) : r.gunDurationMs ? <span className="text-amber-400">{formatDuration(r.gunDurationMs)}</span> : '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    {!isFinished && r.startTime && (
                      <button
                        onClick={() => manualFinish.mutate(r.id)}
                        disabled={manualFinish.isPending}
                        className="border border-apex-yellow text-apex-yellow px-2 py-0.5 text-xs font-bold uppercase tracking-wider hover:bg-apex-yellow hover:text-black transition-colors disabled:opacity-50"
                      >
                        META
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="py-8 text-center text-xs text-apex-muted">Brak wystartowanych zawodników</div>
        )}
      </div>
    </div>
  )
}

export default function Results() {
  const { id } = useParams()
  const qc = useQueryClient()

  const { data: categories = [] } = useQuery({
    queryKey: ['event-results', id],
    queryFn: () => api.results.listForEvent(id),
    refetchInterval: 5000,
  })

  useWsEvent('result:update', () => qc.invalidateQueries({ queryKey: ['event-results', id] }))
  useWsEvent('race:update', () => qc.invalidateQueries({ queryKey: ['event-results', id] }))

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h1 className="font-display text-4xl uppercase tracking-widest text-apex-text-bright">Wyniki</h1>
        <Link to={`/events/${id}/podium`} target="_blank">
          <Button variant="outline" size="sm"><ExternalLink size={12} /> Widok publiczny</Button>
        </Link>
      </div>

      <div className="flex-1 min-h-0">
        <RaceOverview eventId={id} categories={categories} />
      </div>
    </div>
  )
}

function ResultsTable({ raceRunId, results, categoryId, gender }) {
  const qc = useQueryClient()
  const [editRow, setEditRow] = useState(null)

  const { data: rows = results } = useQuery({
    queryKey: ['results', raceRunId, gender],
    queryFn: () => api.results.list(raceRunId, gender),
    initialData: gender ? undefined : results,
    refetchInterval: 10_000,
  })

  const update = useMutation({
    mutationFn: ({ id, ...body }) => api.results.update(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['results', raceRunId] }); setEditRow(null) },
  })

  if (!rows.length) return <div className="text-sm text-apex-muted py-2">Brak wyników.</div>

  return (
    <>
      <div className="border border-apex-border bg-apex-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-apex-border bg-apex-surface-2">
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Poz.</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-12">Nr</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Imię i nazwisko</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Klub</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Start</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Meta</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">
                <span className="flex items-center gap-1" title="Czas netto (chip): od momentu przekroczenia linii startu do mety przez zawodnika">
                  Netto
                  <Info size={11} className="text-apex-dim cursor-help" />
                </span>
              </th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">
                <span className="flex items-center gap-1" title="Czas brutto (gun): od strzału startera (startu biegu) do momentu przekroczenia mety">
                  Brutto
                  <Info size={11} className="text-apex-dim cursor-help" />
                </span>
              </th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Status</th>
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                <td className="px-3 py-2 font-display text-xl text-apex-yellow">{r.position || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.participant?.bibNumber}</td>
                <td className="px-3 py-2 font-medium">
                  {r.participant?.firstName} {r.participant?.lastName}
                  {r.manualOverride && <span className="ml-1 text-xs text-apex-muted" title="Korekta ręczna">✎</span>}
                </td>
                <td className="px-3 py-2 text-apex-muted text-xs">{r.participant?.club || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-apex-muted">{formatDateTime(r.startTime)}</td>
                <td className="px-3 py-2 font-mono text-xs text-apex-muted">{formatDateTime(r.finishTime)}</td>
                <td className="px-3 py-2 font-mono font-semibold">{formatDuration(r.durationMs)}</td>
                <td className="px-3 py-2 font-mono font-semibold text-apex-yellow">{formatDuration(r.gunDurationMs)}</td>
                <td className="px-3 py-2">
                  <Badge className={statusColor(r.status)}>{statusLabel(r.status)}</Badge>
                </td>
                <td className="px-3 py-2 flex items-center gap-1">
                  {r.status === 'started' && !r.finishTime && (
                    <button
                      onClick={() => update.mutate({ id: r.id, finishTime: new Date().toISOString() })}
                      disabled={update.isPending}
                      className="border border-apex-yellow text-apex-yellow px-2 py-0.5 text-xs font-bold uppercase tracking-wider hover:bg-apex-yellow hover:text-black transition-colors disabled:opacity-50"
                    >
                      META
                    </button>
                  )}
                  <button onClick={() => setEditRow(r)} className="text-apex-muted hover:text-apex-text">
                    <Pencil size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editRow && (
        <EditResultDialog
          result={editRow}
          onSave={(vals) => update.mutate({ id: editRow.id, ...vals })}
          onClose={() => setEditRow(null)}
          saving={update.isPending}
        />
      )}
    </>
  )
}

function toLocalDatetimeString(value) {
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function EditResultDialog({ result, onSave, onClose, saving }) {
  const p = result.participant || {}
  const [form, setForm] = useState({
    status: result.status,
    statusNote: result.statusNote || '',
    startTime: result.startTime ? toLocalDatetimeString(result.startTime) : '',
    finishTime: result.finishTime ? toLocalDatetimeString(result.finishTime) : '',
  })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edytuj wynik — #{p.bibNumber} {p.firstName} {p.lastName}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Status</span>
            <Select value={form.status} onValueChange={v => set('status', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {['registered','checked_in','started','finished','dnf','dns','dsq'].map(s => (
                  <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {form.status === 'dsq' && (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Uwaga DSQ *</span>
              <Input value={form.statusNote} onChange={e => set('statusNote', e.target.value)} placeholder="Powód dyskwalifikacji" />
            </label>
          )}
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Czas startu (korekta ręczna)</span>
            <div className="flex items-center gap-2">
              <Input type="datetime-local" step="1" value={form.startTime} onChange={e => set('startTime', e.target.value)} className="flex-1" />
              {!form.startTime && (
                <Button variant="outline" size="sm" type="button" onClick={() => set('startTime', toLocalDatetimeString(new Date()))}>
                  Teraz
                </Button>
              )}
            </div>
          </div>
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Czas mety (korekta ręczna)</span>
            <div className="flex items-center gap-2">
              <Input type="datetime-local" step="1" value={form.finishTime} onChange={e => set('finishTime', e.target.value)} className="flex-1" />
              {!form.finishTime && (
                <Button variant="outline" size="sm" type="button" onClick={() => set('finishTime', toLocalDatetimeString(new Date()))}>
                  Teraz
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-apex-muted">Ręczne ustawienie czasu oznaczy wynik jako korektę ręczną.</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Anuluj</Button>
          <Button onClick={() => onSave({
            status: form.status,
            statusNote: form.statusNote || null,
            startTime: form.startTime ? new Date(form.startTime).toISOString() : undefined,
            finishTime: form.finishTime ? new Date(form.finishTime).toISOString() : undefined,
          })} disabled={saving}>
            {saving ? 'Zapisywanie...' : 'Zapisz'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
