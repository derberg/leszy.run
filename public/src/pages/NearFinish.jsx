import { useMemo } from 'react'
import { anonymizedName } from '../ui/index.js'
import { excludedParticipants, nearFinishRunners } from '../lib/nearFinish.js'
import { nearFinishInputs } from '../lib/resultsSnapshot.js'
import { useResultsSnapshot } from '../hooks/useResultsSnapshot.js'

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Shows runners observed at the near-finish checkpoint who have not finished yet.
 * @param {string} eventId
 * @param {string} nearFinishCheckpointId - the checkpoint with is_near_finish=true
 * @param {Array} categories - all timed categories for this event
 */
export default function NearFinish({ eventId, nearFinishCheckpointId, categories }) {
  const snapshot = useResultsSnapshot(eventId)
  const loading = !snapshot

  const runners = useMemo(() => {
    if (!snapshot) return []
    const { observations, participants, results } = nearFinishInputs(snapshot, nearFinishCheckpointId)
    return nearFinishRunners({
      observations,
      participants,
      excluded: excludedParticipants(results),
      catMap: Object.fromEntries(categories.map(c => [c.id, c.name])),
    })
  }, [snapshot, nearFinishCheckpointId, categories])

  if (loading) {
    return (
      <div className="text-center py-16 text-apex-muted">
        <div className="font-display text-2xl uppercase tracking-widest animate-pulse">Ładowanie...</div>
      </div>
    )
  }

  if (runners.length === 0) {
    return (
      <div className="text-center py-16 text-apex-muted">
        <div className="font-display text-3xl uppercase tracking-widest mb-2">Nikt jeszcze nie minął tego punktu</div>
        <div className="text-sm">Ta strona aktualizuje się automatycznie.</div>
      </div>
    )
  }

  return (
    <div>
      <div className="text-center mb-8">
        <div className="font-display text-4xl tracking-widest uppercase text-apex-text-bright mb-1">Blisko Mety</div>
        <div className="text-apex-muted text-sm">{runners.length} zawodników</div>
      </div>

      <div className="border border-apex-border bg-apex-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-apex-border bg-apex-surface-2">
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-12">Nr</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Kategoria</th>
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Godzina</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {runners.map(r => {
              const { displayName, isAnonymized, tooltip } = anonymizedName(r)
              return (
                <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                  <td className="px-3 py-1.5 font-mono text-xs">#{r.bibNumber}</td>
                  <td className="px-3 py-1.5">
                    <span title={tooltip || undefined} className={isAnonymized ? 'italic text-apex-muted' : ''}>
                      {displayName}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-apex-muted">{r.categoryName}</td>
                  <td className="px-3 py-1.5 font-mono text-apex-cyan">{formatTime(r.observedAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
