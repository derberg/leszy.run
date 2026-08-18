import { useState } from 'react'
import { PositionBadge } from './PositionBadge.jsx'
import { InfoTooltip } from './InfoTooltip.jsx'
import { anonymizedName } from '../lib/anonymizedName.js'

/**
 * @param {Array} results - enriched by estimatePositions (with estimatedPosition, positionType)
 * @param {Array} checkpoints - [{ id, name, kmMarker }] sorted by kmMarker
 * @param {Array} observations - [{ checkpointId, participantId, observedAt }]
 * @param {Function} formatTime - (isoString) => display string
 * @param {Function} [formatDuration] - (ms) => display string for durations
 */
export function CheckpointTrackingTable({ results, checkpoints, observations, formatTime, formatDuration }) {
  const [legendOpen, setLegendOpen] = useState(false)

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

  // A DNS runner never left the start line, so a checkpoint time under their bib is
  // bogus (mistyped volunteer entry, stray read). estimatePositions already keeps
  // them out of the checkpoint ordering tier; this keeps the split columns clean too.
  // DNF/DSQ deliberately keep their splits — they were on course.
  const splitAt = (r, checkpointId) =>
    r.positionType === 'dns'
      ? null
      : obsLookup[`${r.participantId}:${checkpointId}`] || bibLookup[`${r.participant?.bibNumber}:${checkpointId}`]

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

  // Worded to read correctly both as a column tooltip and in the mobile legend,
  // where Start/Meta are labels on a card rather than columns.
  const clockTooltip = (
    <>
      <strong>Start</strong> i <strong>Meta</strong> to <strong>godziny zegarowe</strong> —
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
              const { displayName: pDisplayName, isAnonymized: pIsAnonymized, tooltip: pTooltip } = anonymizedName(p)
              return (
                <tr key={r.id} className="hover:bg-apex-surface-2 transition-colors">
                  <td className="px-2 py-1.5 font-display text-lg text-apex-yellow">{r.estimatedPosition}</td>
                  <td className="px-2 py-1.5 font-mono">#{p?.bibNumber}</td>
                  <td className="px-2 py-1.5 truncate">
                    <span title={pTooltip || undefined} className={pIsAnonymized ? 'italic text-apex-muted' : ''}>{pDisplayName}</span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-apex-muted">
                    {r.startTime ? formatTime(r.startTime) : '—'}
                  </td>
                  {checkpoints.map(cp => {
                    const t = splitAt(r, cp.id)
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

      {/* Mobile legend — the card layout has no column headers, so the desktop
          per-column "?" tooltips have nowhere to hang. Without this the
          brutto/netto distinction is unexplained on phones entirely. */}
      <div className="md:hidden border border-apex-border bg-apex-surface mb-2">
        <button
          type="button"
          onClick={() => setLegendOpen(o => !o)}
          aria-expanded={legendOpen}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
        >
          <span className="text-xs font-bold uppercase tracking-wider text-apex-muted">
            {formatDuration ? 'Brutto vs Netto — co oznaczają te czasy?' : 'Co oznaczają te czasy?'}
          </span>
          <span className="font-mono text-sm leading-none text-apex-yellow">{legendOpen ? '−' : '+'}</span>
        </button>
        {legendOpen && (
          <div className="border-t border-apex-border px-3 pt-2.5 pb-3 space-y-2.5 text-xs text-apex-text">
            {formatDuration && <p>{bruttoTooltip}</p>}
            {formatDuration && <p>{nettoTooltip}</p>}
            <p>{clockTooltip}</p>
            {checkpoints.length > 0 && <p>{checkpointTooltip}</p>}
          </div>
        )}
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {results.map(r => {
          const p = r.participant
          const { displayName: mDisplayName, isAnonymized: mIsAnonymized, tooltip: mTooltip } = anonymizedName(p)
          return (
            <div key={r.id} className="border border-apex-border bg-apex-surface px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-display text-xl text-apex-yellow leading-none">{r.estimatedPosition}</span>
                <span className="font-mono text-xs text-apex-muted">#{p?.bibNumber}</span>
                <span title={mTooltip || undefined} className={`font-semibold text-sm flex-1 truncate${mIsAnonymized ? ' italic text-apex-muted' : ''}`}>{mDisplayName}</span>
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
                  const t = splitAt(r, cp.id)
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
