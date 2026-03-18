/**
 * @param {Array} results - enriched by estimatePositions (with estimatedPosition, positionType)
 * @param {Array} checkpoints - [{ id, name, kmMarker }] sorted by kmMarker
 * @param {Array} observations - [{ checkpointId, participantId, observedAt }]
 * @param {Function} formatTime - (isoString) => display string
 */
export function CheckpointTrackingTable({ results, checkpoints, observations, formatTime }) {
  // Build lookups: by participantId and by bibNumber
  const obsLookup = {}
  const bibLookup = {}
  for (const obs of observations) {
    if (obs.participantId) {
      obsLookup[`${obs.participantId}:${obs.checkpointId}`] = obs.observedAt
    }
    if (obs.bibNumber != null) {
      bibLookup[`${obs.bibNumber}:${obs.checkpointId}`] = obs.observedAt
    }
  }

  return (
    <div className="border border-apex-border bg-apex-surface overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-apex-border bg-apex-surface-2">
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Poz.</th>
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Nr</th>
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Start</th>
            {checkpoints.map(cp => (
              <th key={cp.id} className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-cyan font-mono whitespace-nowrap">
                {cp.name}{cp.kmMarker ? ` (km ${cp.kmMarker})` : ''}
              </th>
            ))}
            <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Meta</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-apex-border">
          {results.map(r => {
            const p = r.participant
            return (
              <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                <td className="px-3 py-1.5 font-display text-lg text-apex-yellow">{r.estimatedPosition}</td>
                <td className="px-3 py-1.5 font-mono">#{p?.bibNumber}</td>
                <td className="px-3 py-1.5">{p?.firstName} {p?.lastName}</td>
                <td className="px-3 py-1.5 font-mono text-apex-muted">
                  {r.startTime ? formatTime(r.startTime) : '\u2014'}
                </td>
                {checkpoints.map(cp => {
                  const t = obsLookup[`${r.participantId}:${cp.id}`] || bibLookup[`${r.participant?.bibNumber}:${cp.id}`]
                  return (
                    <td key={cp.id} className="px-3 py-1.5 font-mono text-apex-cyan">
                      {t ? formatTime(t) : <span className="text-apex-dim">{'\u2014'}</span>}
                    </td>
                  )
                })}
                <td className="px-3 py-1.5 font-mono font-bold text-apex-yellow-bright">
                  {r.finishTime ? formatTime(r.finishTime) : '\u2014'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
