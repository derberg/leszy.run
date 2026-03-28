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
import { Download, ExternalLink, Info, Pencil, Upload } from 'lucide-react'

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

export default function Results() {
  const { id } = useParams()

  const { data: categories = [] } = useQuery({
    queryKey: ['event-results', id],
    queryFn: () => api.results.listForEvent(id),
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-4xl uppercase tracking-widest text-apex-text-bright">Wyniki</h1>
        <Link to={`/events/${id}/podium`} target="_blank">
          <Button variant="outline" size="sm"><ExternalLink size={12} /> Widok publiczny</Button>
        </Link>
      </div>

      <div className="space-y-6">
        {categories.map(cat => (
          <CategoryBlock key={cat.id} cat={cat} eventId={id} />
        ))}
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
                <td className="px-3 py-2">
                  <button onClick={() => setEditRow(r)} className="text-apex-text hover:text-apex-text">
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
