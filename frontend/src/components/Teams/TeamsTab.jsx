import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { teamLabels, teamLabelText } from '../../lib/teamGroups.js'
import { Button } from '../ui/button.jsx'
import RfidAssignDialog from '../ParticipantsTable/RfidAssignDialog.jsx'
import { Wifi } from 'lucide-react'
import { batonTagClashes } from '../../lib/batons.js'

const shortEpc = (epc) => epc.length > 8 ? `…${epc.slice(-6)}` : epc

export default function TeamsTab({ eventId, categories }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState(null) // { teamId, label }
  const [error, setError] = useState(null)

  const relayCats = (categories || []).filter(c => c.teamMode === 'relay_free')

  const { data: participants = [] } = useQuery({
    queryKey: ['participants', eventId],
    queryFn: () => api.participants.list(eventId),
  })
  const { data: teamNames = {} } = useQuery({
    queryKey: ['team-names', eventId],
    queryFn: () => api.participants.teamNames(eventId),
    enabled: relayCats.length > 0,
    staleTime: 60_000,
  })
  const { data: batons = [] } = useQuery({
    queryKey: ['team-batons', eventId],
    queryFn: () => api.teamBatons.list(eventId).then(r => r.data ?? r),
    enabled: relayCats.length > 0,
  })

  const { data: races = [] } = useQuery({
    queryKey: ['races', eventId],
    queryFn: () => api.races.list(eventId),
    enabled: relayCats.length > 0,
  })
  const activeCats = new Set(races.filter(r => r.status === 'active').map(r => r.categoryId))

  const refresh = () => qc.invalidateQueries({ queryKey: ['team-batons', eventId] })

  const setBaton = useMutation({
    mutationFn: ({ teamId, epc }) => api.teamBatons.put(eventId, teamId, epc),
    onSuccess: () => { setError(null); refresh() },
    onError: (err) => setError(err.message),
  })
  // The baton tag read from the reader dialog. A refusal rejects mutateAsync, which the dialog
  // shows inline; the page-level error stays for the other actions.
  const assignBaton = useMutation({
    mutationFn: ({ teamId, epc }) => api.teamBatons.put(eventId, teamId, epc),
    onSuccess: () => { setError(null); refresh(); setTarget(null) },
  })
  const setSource = useMutation({
    mutationFn: ({ id, teamLapSource }) => api.categories.update(id, { teamLapSource }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['categories', eventId] }) },
    onError: (err) => setError(err.message),
  })

  const labels = teamLabels(participants, teamNames)
  const batonOf = Object.fromEntries(batons.filter(b => b.epc).map(b => [b.teamId, b.epc]))
  const clashes = batonTagClashes(batons, participants)

  if (relayCats.length === 0) {
    return <div className="py-12 text-center text-apex-muted text-sm">Brak kategorii sztafetowych.</div>
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-xs text-terrain-burgundy border border-red-200 bg-red-50 px-3 py-2">{error}</p>
      )}
      {relayCats.map(cat => {
        const isBaton = cat.teamLapSource === 'baton'
        const running = activeCats.has(cat.id)
        const teams = [...new Set(participants.filter(p => p.teamId && p.categoryId === cat.id).map(p => p.teamId))]
          .map(teamId => ({ teamId, text: teamLabelText(labels.get(teamId)), bibs: participants.filter(p => p.teamId === teamId && p.bibNumber != null).map(p => p.bibNumber).sort((a, b) => a - b) }))
          .sort((a, b) => (a.text || '').localeCompare(b.text || '', 'pl', { sensitivity: 'base' }))
        return (
          <section key={cat.id} className="border border-apex-border bg-apex-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-apex-border px-4 py-3">
              <h2 className="font-display text-xl uppercase tracking-wider text-apex-text-bright">{cat.name}</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {running && (
                  <span className="text-xs text-apex-yellow whitespace-nowrap">Nie można zmienić sposobu liczenia w trakcie biegu.</span>
                )}
                <span className="text-xs uppercase tracking-widest text-apex-muted whitespace-nowrap">Liczenie okrążeń</span>
                <div className="flex">
                  {[['baton', 'pałka'], ['runner', 'zawodnicy']].map(([v, l]) => (
                    <Button
                      key={v}
                      size="sm"
                      variant={(cat.teamLapSource || 'runner') === v ? 'default' : 'outline'}
                      className="whitespace-nowrap"
                      disabled={setSource.isPending || running}
                      onClick={() => (cat.teamLapSource || 'runner') !== v && setSource.mutate({ id: cat.id, teamLapSource: v })}
                    >
                      {l}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <ul className="divide-y divide-apex-border">
              {teams.map(t => {
                const epc = batonOf[t.teamId]
                return (
                  <li key={t.teamId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                    <div className="min-w-0 flex-1 basis-40">
                      <div className="truncate text-sm text-apex-text-bright">{t.text}</div>
                      <div className="font-mono text-xs text-apex-muted">{t.bibs.map(b => `#${b}`).join(' ') || '—'}</div>
                      {clashes.has(t.teamId) && <div className="text-xs text-apex-red">Tag pałki jest też tagiem zawodnika</div>}
                    </div>
                    <div className="whitespace-nowrap text-xs font-mono">
                      {epc ? (
                        <span className="flex items-center gap-1 text-apex-yellow" title={epc}><Wifi size={11} />{shortEpc(epc)}</span>
                      ) : isBaton ? (
                        <span className="text-apex-red">brak pałki</span>
                      ) : (
                        <span className="text-apex-muted">—</span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => setTarget({ teamId: t.teamId, label: t.text })}>Przypisz</Button>
                      {epc && (
                        <Button size="sm" variant="outline" className="whitespace-nowrap" disabled={setBaton.isPending} onClick={() => setBaton.mutate({ teamId: t.teamId, epc: null })}>Usuń</Button>
                      )}
                    </div>
                  </li>
                )
              })}
              {teams.length === 0 && <li className="px-4 py-6 text-center text-sm text-apex-muted">Brak drużyn.</li>}
            </ul>
          </section>
        )
      })}

      {target && (
        <RfidAssignDialog
          label={target.label}
          onAssign={(epc) => assignBaton.mutateAsync({ teamId: target.teamId, epc })}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  )
}
