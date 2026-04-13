import { useState } from 'react'
import { PositionBadge } from './PositionBadge.jsx'

function InfoTooltip({ label, children }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label={`Wyjaśnienie: ${label}`}
        className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-apex-muted text-apex-muted text-[9px] hover:border-apex-yellow hover:text-apex-yellow cursor-pointer leading-none"
      >
        ?
      </button>
      {open && (
        <span className="absolute z-50 top-5 left-0 w-64 text-left bg-apex-bg border border-apex-yellow p-2 text-xs font-normal normal-case tracking-normal text-apex-text shadow-lg whitespace-normal">
          {children}
        </span>
      )}
    </span>
  )
}

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

  const checkpointTooltip = (
    <>
      Czasy na punktach kontrolnych są <strong>nieoficjalne</strong> — to pomocnicze dane
      pozwalające śledzić, gdzie aktualnie są zawodnicy na trasie.
      <br /><br />
      Jeśli jakiś czas nie jest widoczny, <strong>nie znaczy to, że zawodnik go minął</strong> —
      być może było zbyt wielu biegaczy naraz i wolontariusze nie zdążyli zapisać wszystkich numerów.
    </>
  )

  const nettoTooltip = (
    <>
      <strong>Czas Netto (chip):</strong> od momentu przekroczenia linii startu przez
      zawodnika do przekroczenia linii mety. To czas właściwy dla zawodnika,
      niezależny od tego jak szybko dotarł do linii startu po strzale.
    </>
  )

  const bruttoTooltip = (
    <>
      <strong>Czas Brutto (gun):</strong> od strzału startera (oficjalnego startu biegu)
      do momentu przekroczenia linii mety. Jest to czas oficjalny, użytkowany
      do klasyfikacji miejsc w wynikach.
    </>
  )

  const clockTooltip = (
    <>
      Kolumny <strong>Start</strong> i <strong>Meta</strong> pokazują <strong>godziny zegarowe</strong> —
      dokładny moment, w którym zawodnik przekroczył linię startu i mety.
      To nie są czasy biegu, tylko rzeczywiste godziny.
    </>
  )

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block border border-apex-border bg-apex-surface overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-apex-border bg-apex-surface-2">
              <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-10">Poz.</th>
              <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-12">Nr</th>
              <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted">Zawodnik</th>
              <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono w-20">
                <span className="inline-flex items-center">Start<InfoTooltip label="Start">{clockTooltip}</InfoTooltip></span>
              </th>
              {checkpoints.map((cp, i) => (
                <th key={cp.id} className="text-center px-1 py-2 text-xs font-bold uppercase tracking-wider text-apex-cyan font-mono truncate" title={cp.name}>
                  <span className="inline-flex items-center">
                    {cp.name}
                    {i === 0 && <InfoTooltip label="Punkty kontrolne">{checkpointTooltip}</InfoTooltip>}
                  </span>
                  {cp.kmMarker && <div className="text-apex-dim font-normal text-[10px]">{cp.kmMarker}km</div>}
                </th>
              ))}
              <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono w-16">Meta</th>
              {formatDuration && <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted font-mono w-24">
                <span className="inline-flex items-center">Netto<InfoTooltip label="Netto">{nettoTooltip}</InfoTooltip></span>
              </th>}
              {formatDuration && <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-yellow font-mono w-24">
                <span className="inline-flex items-center">Brutto<InfoTooltip label="Brutto">{bruttoTooltip}</InfoTooltip></span>
              </th>}
              <th className="text-left px-2 py-2 text-xs font-bold uppercase tracking-wider text-apex-muted w-24">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-apex-border">
            {results.map(r => {
              const p = r.participant
              return (
                <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                  <td className="px-2 py-1.5 font-display text-lg text-apex-yellow">{r.estimatedPosition}</td>
                  <td className="px-2 py-1.5 font-mono">#{p?.bibNumber}</td>
                  <td className="px-2 py-1.5 truncate">{p?.firstName} {p?.lastName}</td>
                  <td className="px-2 py-1.5 font-mono text-apex-muted">
                    {r.startTime ? formatTime(r.startTime) : '—'}
                  </td>
                  {checkpoints.map(cp => {
                    const t = obsLookup[`${r.participantId}:${cp.id}`] || bibLookup[`${r.participant?.bibNumber}:${cp.id}`]
                    return (
                      <td key={cp.id} className="text-center px-1 py-1.5 font-mono text-apex-cyan">
                        {t ? formatTime(t) : <span className="text-apex-dim">{'—'}</span>}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1.5 font-mono font-bold text-apex-yellow-bright">
                    {r.finishTime ? formatTime(r.finishTime) : '—'}
                  </td>
                  {formatDuration && (
                    <td className="px-2 py-1.5 font-mono text-apex-muted">
                      {r.durationMs ? formatDuration(r.durationMs) : '—'}
                    </td>
                  )}
                  {formatDuration && (
                    <td className="px-2 py-1.5 font-mono font-bold text-apex-yellow">
                      {r.gunDurationMs ? formatDuration(r.gunDurationMs) : '—'}
                    </td>
                  )}
                  <td className="px-2 py-1.5">
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
