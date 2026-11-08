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
  useWsEvent('team:lap', (p) => { if (p?.raceRunId === run.id) qc.invalidateQueries({ queryKey: key }) })

  const [open, setOpen] = useState(() => new Set())
  const [dialog, setDialog] = useState(null) // { teamId, lap? }
  const [error, setError] = useState('')

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
  const removedOf = (teamId) => laps.filter(l => l.teamId === teamId && l.deletedAt)
  const toggle = (id) => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <Card className="mb-4">
      <CardHeader className="py-2.5">
        <CardTitle className="text-sm">{category.name} · okrążenia drużyn</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error && <div className="px-3 py-2 text-xs text-apex-red border-b border-apex-border">{error}</div>}
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
              const removed = removedOf(t.teamId)
              return [
                <tr key={t.teamId} className="hover:bg-apex-surface-2">
                  <td className="px-2 py-1.5">
                    <button type="button" onClick={() => toggle(t.teamId)} className="text-apex-muted hover:text-apex-text" aria-expanded={isOpen}>
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 font-display text-lg text-apex-yellow">{t.position ?? '—'}</td>
                  <td className="px-2 py-1.5">
                    {/* The host holds no team names: the squad's surnames say which team it is. */}
                    <span className="block truncate text-apex-text">{membersOf(t.teamId).map(p => p.lastName).join(' · ')}</span>
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
                      <table className="w-full">
                        <tbody className="divide-y divide-apex-border">
                          {t.members.map(m => (
                            <tr key={m.lapId}>
                              <td className="py-1 pr-2 w-14 font-bold text-apex-muted uppercase">Okr. {m.leg}</td>
                              <td className="py-1 pr-2">
                                <Select value={m.participantId} onValueChange={v => update.mutate({ id: m.lapId, participantId: v })}>
                                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {membersOf(t.teamId).map(p => <SelectItem key={p.id} value={p.id}>{fullName(p)}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="py-1 pr-2 w-20 text-right font-mono">{m.legMs != null ? formatDuration(m.legMs) : '—'}</td>
                              <td className="py-1 pr-2 w-20 text-right font-mono text-apex-muted">{clock(m.closedAt)}</td>
                              <td className="py-1 pr-2 w-16 text-apex-muted">{m.source === 'manual' ? 'ręcznie' : 'chip'}</td>
                              <td className="py-1 w-16 text-right whitespace-nowrap">
                                <button type="button" title="Zmień czas" className="text-apex-muted hover:text-apex-text mr-2"
                                  onClick={() => setDialog({ teamId: t.teamId, lap: m })}><Pencil size={13} /></button>
                                <button type="button" title="Usuń" className="text-apex-muted hover:text-apex-red"
                                  onClick={() => update.mutate({ id: m.lapId, deleted: true })}><Trash2 size={13} /></button>
                              </td>
                            </tr>
                          ))}
                          {removed.map(l => (
                            <tr key={l.id} className="opacity-50">
                              <td className="py-1 pr-2 w-14 font-bold text-apex-muted uppercase">Usunięte</td>
                              <td className="py-1 pr-2 line-through">{fullName(membersOf(t.teamId).find(p => p.id === l.participantId))}</td>
                              <td></td>
                              <td className="py-1 pr-2 text-right font-mono line-through">{clock(l.closedAt)}</td>
                              <td className="py-1 pr-2 text-apex-muted">{l.source === 'manual' ? 'ręcznie' : 'chip'}</td>
                              <td className="py-1 text-right">
                                <button type="button" title="Przywróć" className="text-apex-muted hover:text-apex-text"
                                  onClick={() => update.mutate({ id: l.id, deleted: false })}><RotateCcw size={13} /></button>
                              </td>
                            </tr>
                          ))}
                          {!t.members.length && !removed.length && (
                            <tr><td className="py-1 text-apex-muted">—</td></tr>
                          )}
                        </tbody>
                      </table>
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
    </Card>
  )
}

function LapDialog({ members, lap, saving, error, onClose, onSave }) {
  const [participantId, setParticipantId] = useState(lap?.participantId ?? members[0]?.id ?? '')
  const [at, setAt] = useState(toLocal(lap?.closedAt ?? new Date()))
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{lap ? `Okrążenie ${lap.leg} · czas` : 'Dodaj okrążenie'}</DialogTitle>
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
