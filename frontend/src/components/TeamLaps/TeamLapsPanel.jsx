import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { computeTeamResults } from '@leszyrun/ui/teamResults'
import { api } from '../../lib/api.js'
import { useWsEvent } from '../../lib/ws.js'
import { formatDuration, cn } from '../../lib/utils.js'
import { Button } from '../ui/button.jsx'
import { Input } from '../ui/input.jsx'
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card.jsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../ui/dialog.jsx'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select.jsx'
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { sameLapNeighbours, needsDecision, SAME_LAP_FALLBACK_MS } from '../../lib/teamLapReview.js'

// Relay in any order: the teams' laps live, and the operator's corrections (add a lap the
// chip missed, move one to the teammate who ran it, fix its time, remove a false one).
// Standings come from @leszyrun/ui computeTeamResults, the same rule as the public page.

const pad = (n) => String(n).padStart(2, '0')
const toLocal = (v) => {
  const d = new Date(v)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const clock = (v) => new Date(v).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fullName = (p) => `#${p?.bibNumber ?? '—'} ${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim()

export default function TeamLapsPanel({ category, run }) {
  const qc = useQueryClient()
  const key = ['team-laps', run.id]
  const { data: laps = [] } = useQuery({ queryKey: key, queryFn: () => api.teamLaps.list(run.id), refetchInterval: 5000 })
  // The same names as the participants table: a host team's from host_teams, a registration
  // team's read from Supabase (never stored on the host); none → the squad's surnames.
  const { data: teamNames = {} } = useQuery({
    queryKey: ['team-names', category.eventId],
    queryFn: () => api.participants.teamNames(category.eventId),
    enabled: !!category.eventId,
    staleTime: 60_000,
  })
  const { data: event } = useQuery({
    queryKey: ['events', category.eventId],
    queryFn: () => api.events.get(category.eventId),
    enabled: !!category.eventId,
    staleTime: 60_000,
  })
  // Two laps of one team closer than the min lap time are one lap.
  const sameLapMs = event?.minFinishSeconds > 0 ? event.minFinishSeconds * 1000 : SAME_LAP_FALLBACK_MS
  useWsEvent('team:lap', (p) => { if (p?.raceRunId === run.id) qc.invalidateQueries({ queryKey: key }) })

  const [open, setOpen] = useState(() => new Set())
  const [dialog, setDialog] = useState(null) // { teamId, lap? }
  const [error, setError] = useState('')
  const [byRunner, setByRunner] = useState(false)
  const [confirm, setConfirm] = useState(null) // { title, lines, actions: [{ label, run }] }

  const done = () => { setError(''); qc.invalidateQueries({ queryKey: key }) }
  const create = useMutation({ mutationFn: (body) => api.teamLaps.create(run.id, body), onSuccess: () => { done(); setDialog(null) }, onError: (e) => setError(e.message) })
  const update = useMutation({ mutationFn: ({ id, ...body }) => api.teamLaps.update(id, body), onSuccess: () => { done(); setDialog(null) }, onError: (e) => setError(e.message) })

  const results = (run.results || []).filter(r => r.participant?.teamId && !r.participant.removedAt)
  const teams = computeTeamResults({
    mode: 'relay_free', results, laps, gunStartedAt: run.startedAt,
    lapCount: category.teamLapCount ?? undefined,
    raceFinished: run.status === 'finished',
  })
  const membersOf = (teamId) => results.filter(r => r.participant.teamId === teamId).map(r => r.participant)
  const legOf = new Map()
  for (const t of teams) for (const m of t.members) legOf.set(m.lapId, m)
  const rowsOf = (teamId) => laps
    .filter(l => l.teamId === teamId)
    .map(l => ({ ...l, leg: legOf.get(l.id)?.leg, legMs: legOf.get(l.id)?.legMs }))
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))
  const act = {
    setRunner: (lap, participantId) => update.mutate({ id: lap.id, participantId }),
    editTime: (lap) => setDialog({ teamId: lap.teamId, lap: { ...lap, lapId: lap.id } }),
    review: (lap) => update.mutate({ id: lap.id, reviewed: !lap.reviewedAt }),
    // A counted lap is a lap of the standings: removing it asks first.
    reject: (lap) => lap.status === 'counted'
      ? setConfirm({
        title: 'Odrzucić okrążenie?',
        lines: [lapLine(lap)],
        actions: [{ label: 'Odrzuć', run: () => update.mutate({ id: lap.id, deleted: true }) }],
      })
      : update.mutate({ id: lap.id, deleted: true }),
    restore: (lap) => update.mutate({ id: lap.id, deleted: false }),
    // Approving a candidate: other candidates of the team within the min lap time are the same
    // lap; they are rejected only once the operator confirms the list.
    count: (lap) => {
      const others = sameLapNeighbours(lap, laps, sameLapMs).filter(l => l.status === 'candidate')
      if (!others.length) return update.mutate({ id: lap.id, status: 'counted' })
      setConfirm({
        title: `Zaliczyć ${clock(lap.closedAt)} i odrzucić?`,
        lines: others.map(lapLine),
        actions: [
          { label: 'Tylko zalicz', outline: true, run: () => update.mutate({ id: lap.id, status: 'counted' }) },
          { label: 'Zalicz i odrzuć', run: async () => {
            try {
              await update.mutateAsync({ id: lap.id, status: 'counted' })
              for (const o of others) await update.mutateAsync({ id: o.id, deleted: true })
            } catch { /* the error is shown by the mutation */ }
          } },
        ],
      })
    },
  }
  const runnerOf = (lap) => results.find(r => r.participantId === lap.participantId)?.participant
  const lapLine = (lap) => `${clock(lap.closedAt)} · ${lap.participantId ? fullName(runnerOf(lap)) : 'bez biegacza'}`
  const sameLap = (lap) => lap.status === 'candidate' && !lap.deletedAt && sameLapNeighbours(lap, laps, sameLapMs).length > 0
  const pending = laps.filter(needsDecision)
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))
  const teamLabel = (teamId) => teamNames[teamId] || membersOf(teamId).map(p => p.lastName).join(' · ')
  const toggle = (id) => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <Card className="mb-4">
      <CardHeader className="py-2.5">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="truncate">{category.name} · okrążenia drużyn</span>
          <Button variant="outline" size="sm" className="whitespace-nowrap shrink-0" onClick={() => setByRunner(v => !v)}>
            {byRunner ? 'Według czasu' : 'Według biegaczy'}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error && <div className="px-3 py-2 text-xs text-apex-red border-b border-apex-border">{error}</div>}
        {pending.length > 0 && (
          <div className="border-b border-apex-border">
            <div className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-apex-yellow">Do decyzji ({pending.length})</div>
            <div className="px-2 pb-2">
              {pending.map(l => (
                <div key={l.id}>
                  <div className="px-1 pt-1 text-[11px] text-apex-muted truncate">{teamLabel(l.teamId)}</div>
                  <LapRow lap={{ ...l, leg: legOf.get(l.id)?.leg, legMs: legOf.get(l.id)?.legMs }} members={membersOf(l.teamId)} act={act} sameLap={sameLap(l)} decide />
                </div>
              ))}
            </div>
          </div>
        )}
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-apex-border bg-apex-surface-2 text-apex-muted uppercase tracking-wider">
              <th className="text-left px-2 py-2 w-8"></th>
              <th className="text-left px-2 py-2 w-10">Poz.</th>
              <th className="text-left px-2 py-2">Drużyna</th>
              <th className="text-right px-2 py-2 w-16">Okr.</th>
              <th className="text-right px-2 py-2 w-24">Ostatnie</th>
              <th className="text-right px-2 py-2 w-24">Strata</th>
              <th className="px-2 py-2 w-28"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {teams.map(t => {
              const isOpen = open.has(t.teamId)
              return [
                <tr key={t.teamId} className="hover:bg-apex-surface-2">
                  <td className="px-2 py-1.5">
                    <button type="button" onClick={() => toggle(t.teamId)} className="text-apex-muted hover:text-apex-text" aria-expanded={isOpen}>
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 font-display text-lg text-apex-yellow">{t.position ?? '—'}</td>
                  <td className="px-2 py-1.5">
                    {(() => {
                      const surnames = membersOf(t.teamId).map(p => p.lastName).join(' · ')
                      const name = teamNames[t.teamId]
                      return <span className={cn('block truncate', name ? 'text-apex-text-bright' : 'text-apex-text')} title={surnames}>{name || surnames}</span>
                    })()}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono font-bold text-apex-yellow-bright">{t.completed}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{t.totalMs != null ? formatDuration(t.totalMs) : '—'}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-apex-muted">
                    {t.gapLaps > 0 ? `−${t.gapLaps} okr.` : t.gapMs > 0 ? `+${formatDuration(t.gapMs)}` : ''}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => setDialog({ teamId: t.teamId })}>
                      <Plus size={12} /> Okrążenie
                    </Button>
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`${t.teamId}-laps`} className="bg-apex-surface-2">
                    <td></td>
                    <td colSpan={6} className="px-2 py-2">
                      <LapList rows={rowsOf(t.teamId)} members={membersOf(t.teamId)} byRunner={byRunner} act={act} sameLap={sameLap} />
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      </CardContent>

      {dialog && (
        <LapDialog
          members={membersOf(dialog.teamId)}
          lap={dialog.lap}
          saving={create.isPending || update.isPending}
          error={error}
          onClose={() => { setDialog(null); setError('') }}
          onSave={(vals) => dialog.lap
            ? update.mutate({ id: dialog.lap.lapId, closedAt: vals.closedAt })
            : create.mutate(vals)}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} saving={update.isPending} onClose={() => setConfirm(null)} />}
    </Card>
  )
}

const SOURCE = { baton: 'pałka', chip: 'chip', manual: 'ręcznie' }
const stateOf = (l) => l.deletedAt ? 'odrzucone' : l.status === 'candidate' ? 'kandydat' : l.reviewedAt ? 'zatwierdzone' : 'liczone'
const STATE_CLASS = {
  odrzucone: 'text-apex-red border-apex-red/40',
  kandydat: 'text-apex-cyan border-apex-cyan/40',
  zatwierdzone: 'text-green-400 border-green-700',
  liczone: 'text-apex-muted border-apex-border',
}

function LapList({ rows, members, byRunner, act, sameLap }) {
  if (!rows.length) return <div className="text-apex-muted">—</div>
  if (!byRunner) return <div className="divide-y divide-apex-border">{rows.map(l => <LapRow key={l.id} lap={l} members={members} act={act} sameLap={sameLap(l)} />)}</div>
  const groups = [...members.map(p => [p.id, fullName(p)]), [null, 'bez biegacza']]
  return (
    <div className="space-y-2">
      {groups.map(([id, label]) => {
        const mine = rows.filter(l => (l.participantId ?? null) === id)
        if (!mine.length) return null
        return (
          <div key={id ?? 'none'}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-apex-muted">
              {label} · {mine.filter(l => !l.deletedAt && l.status === 'counted').length} okr.
            </div>
            <div className="divide-y divide-apex-border">{mine.map(l => <LapRow key={l.id} lap={l} members={members} act={act} sameLap={sameLap(l)} />)}</div>
          </div>
        )
      })}
    </div>
  )
}

function LapRow({ lap, members, act, decide, sameLap }) {
  const state = stateOf(lap)
  const counted = lap.status === 'counted' && !lap.deletedAt
  const iconBtn = 'text-apex-muted hover:text-apex-text'
  return (
    <div className={cn('py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1', lap.deletedAt && 'opacity-60')}>
      <span className="w-12 font-bold text-apex-muted uppercase shrink-0">{counted && lap.leg != null ? `Okr. ${lap.leg}` : ''}</span>
      <span className={cn('font-mono text-apex-muted', lap.deletedAt && 'line-through')}>{clock(lap.closedAt)}</span>
      <span className="font-mono min-w-[6rem] shrink-0 whitespace-nowrap text-right">{counted && lap.legMs != null ? formatDuration(lap.legMs) : '—'}</span>
      <div className="min-w-[9rem] flex-1 basis-40">
        <Select value={lap.participantId ?? ''} onValueChange={v => act.setRunner(lap, v)}>
          <SelectTrigger className="h-7 text-xs" title="Zmień biegacza"><SelectValue placeholder="bez biegacza" /></SelectTrigger>
          <SelectContent>
            {members.map(p => <SelectItem key={p.id} value={p.id}>{fullName(p)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <span className="text-apex-muted whitespace-nowrap">{SOURCE[lap.source] ?? lap.source}</span>
      <span className="font-mono text-apex-muted whitespace-nowrap">{lap.peakRssiCdbm != null ? `${(lap.peakRssiCdbm / 100).toFixed(1)} dBm` : ''}</span>
      <span className={cn('border px-1.5 py-0.5 uppercase tracking-wider text-[10px] whitespace-nowrap', STATE_CLASS[state])}>{state}</span>
      {sameLap && <span className="text-apex-yellow whitespace-nowrap">to samo okrążenie?</span>}
      <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
        {lap.status === 'candidate' && !lap.deletedAt && (
          <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => act.count(lap)}>Zalicz</Button>
        )}
        {!decide && (
          <button type="button" title="Zmień czas" className={iconBtn} onClick={() => act.editTime(lap)}><Pencil size={13} /></button>
        )}
        {counted && (!decide || !lap.reviewedAt) && (
          <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => act.review(lap)}>
            {lap.reviewedAt ? 'Cofnij zatw.' : 'Zatwierdź'}
          </Button>
        )}
        {lap.deletedAt
          ? <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => act.restore(lap)}><RotateCcw size={12} /> Przywróć</Button>
          : <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => act.reject(lap)}><Trash2 size={12} /> Odrzuć</Button>}
      </span>
    </div>
  )
}

function LapDialog({ members, lap, saving, error, onClose, onSave }) {
  const [participantId, setParticipantId] = useState(lap?.participantId ?? members[0]?.id ?? '')
  const [at, setAt] = useState(toLocal(lap?.closedAt ?? new Date()))
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{!lap ? 'Dodaj okrążenie' : lap.leg != null ? `Okrążenie ${lap.leg} · czas` : 'Zmień czas'}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {!lap && (
            <div>
              <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Zawodnik</span>
              <Select value={participantId} onValueChange={setParticipantId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {members.map(p => <SelectItem key={p.id} value={p.id}>{fullName(p)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-apex-muted mb-1 block">Przebiegnięcie bramki</span>
            <div className="flex items-center gap-2">
              <Input type="datetime-local" step="1" value={at} onChange={e => setAt(e.target.value)} className="flex-1" />
              <Button variant="outline" size="sm" type="button" onClick={() => setAt(toLocal(new Date()))}>Teraz</Button>
            </div>
          </div>
          {error && <p className={cn('text-xs text-apex-red')}>{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Anuluj</Button>
          <Button disabled={saving || !at || (!lap && !participantId)}
            onClick={() => onSave({ participantId, closedAt: new Date(at).toISOString() })}>
            {saving ? 'Zapisywanie...' : 'Zapisz'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmDialog({ title, lines, actions, saving, onClose }) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ul className="space-y-1 font-mono text-xs">
            {lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" className="whitespace-nowrap" onClick={onClose}>Anuluj</Button>
          {actions.map(a => (
            <Button key={a.label} variant={a.outline ? 'outline' : 'default'} className="whitespace-nowrap" disabled={saving}
              onClick={async () => { await a.run(); onClose() }}>
              {a.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
