import { PositionBadge } from './PositionBadge.jsx'

/**
 * @param {Array} results - enriched by estimatePositions (with estimatedPosition, positionType)
 * @param {Array} checkpoints - [{ id, name, kmMarker }] sorted by kmMarker
 * @param {Array} observations - [{ checkpointId, participantId, observedAt }]
 * @param {Function} formatTime - (isoString) => display string
 * @param {Function} [formatDuration] - (ms) => display string for durations
 */
export function CheckpointTrackingTable({ results, checkpoints, observations, formatTime, formatDuration }) {
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
    <>
      {/* Desktop table */}
      <div className="hidden md:block border border-apex-border bg-apex-surface overflow-x-auto">
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
              {formatDuration && <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono">Netto</th>}
              {formatDuration && <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-yellow font-mono">Brutto</th>}
              <th className="text-left px-3 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Status</th>
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
                  {formatDuration && (
                    <td className="px-3 py-1.5 font-mono text-apex-muted">
                      {r.durationMs ? formatDuration(r.durationMs) : '\u2014'}
                    </td>
                  )}
                  {formatDuration && (
                    <td className="px-3 py-1.5 font-mono font-bold text-apex-yellow">
                      {r.gunDurationMs ? formatDuration(r.gunDurationMs) : '\u2014'}
                    </td>
                  )}
                  <td className="px-3 py-1.5">
                    <PositionBadge positionType={r.positionType} gender={p?.gender} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {results.map(r => {
          const p = r.participant
          return (
            <div key={r.id} className="border border-apex-border bg-apex-surface px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-display text-xl text-apex-yellow leading-none">{r.estimatedPosition}</span>
                <span className="font-mono text-xs text-apex-muted">#{p?.bibNumber}</span>
                <span className="font-semibold text-sm flex-1 truncate">{p?.firstName} {p?.lastName}</span>
                <PositionBadge positionType={r.positionType} gender={p?.gender} />
              </div>

              {formatDuration && (r.gunDurationMs || r.durationMs) && (
                <div className="flex items-center gap-3 mb-1.5">
                  {r.gunDurationMs && (
                    <div>
                      <span className="text-xs text-apex-muted uppercase tracking-wider">Brutto </span>
                      <span className="font-mono font-bold text-sm text-apex-yellow">{formatDuration(r.gunDurationMs)}</span>
                    </div>
                  )}
                  {r.durationMs && r.durationMs !== r.gunDurationMs && (
                    <div>
                      <span className="text-xs text-apex-muted uppercase tracking-wider">Netto </span>
                      <span className="font-mono text-sm text-apex-muted">{formatDuration(r.durationMs)}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                {r.startTime && (
                  <div>
                    <span className="text-apex-muted">Start </span>
                    <span className="font-mono text-apex-text">{formatTime(r.startTime)}</span>
                  </div>
                )}
                {checkpoints.map(cp => {
                  const t = obsLookup[`${r.participantId}:${cp.id}`] || bibLookup[`${r.participant?.bibNumber}:${cp.id}`]
                  if (!t) return null
                  return (
                    <div key={cp.id}>
                      <span className="text-apex-cyan">{cp.name} </span>
                      <span className="font-mono text-apex-text">{formatTime(t)}</span>
                    </div>
                  )
                })}
                {r.finishTime && (
                  <div>
                    <span className="text-apex-muted">Meta </span>
                    <span className="font-mono font-bold text-apex-yellow-bright">{formatTime(r.finishTime)}</span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
