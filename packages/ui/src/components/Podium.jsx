import { PositionBadge } from './PositionBadge.jsx'

/**
 * @param {Array} top3 - up to 3 result objects with { participant, gunDurationMs, durationMs, positionType }
 * @param {Array} animals - array of emoji strings, one per top3 entry
 * @param {Function} formatDuration - (ms) => string
 */
export function Podium({ top3, animals, formatDuration }) {
  const [first, second, third] = top3
  return (
    <div className="flex items-end justify-center gap-4">
      {second && <PodiumBox place={2} result={second} animal={animals[1]} formatDuration={formatDuration} />}
      {first  && <PodiumBox place={1} result={first}  animal={animals[0]} formatDuration={formatDuration} />}
      {third  && <PodiumBox place={3} result={third}  animal={animals[2]} formatDuration={formatDuration} />}
    </div>
  )
}

const platformColors = {
  1: 'bg-apex-surface-2/50 border-t-4 border-yellow-500',
  2: 'bg-apex-surface-2/30 border-t-4 border-stone-400',
  3: 'bg-apex-surface-2/20 border-t-4 border-amber-600',
}
const platformHeights = { 1: 'h-28', 2: 'h-20', 3: 'h-16' }
const placeColors = {
  1: 'text-yellow-400',
  2: 'text-apex-muted',
  3: 'text-amber-600',
}

function PodiumBox({ place, result, animal, formatDuration }) {
  const p = result.participant
  return (
    <div className="flex-1 max-w-40 flex flex-col items-center">
      <div className="text-6xl leading-none mb-2">{animal}</div>
      <div className="font-display text-base tracking-wider text-center leading-tight text-apex-text-bright mb-1 px-1">
        {p?.firstName}<br />{p?.lastName}
      </div>
      {p?.club && (
        <div className="text-[10px] text-apex-muted text-center leading-tight mb-1 px-1 italic break-words">
          {p.club}
        </div>
      )}
      <div className="mb-2">
        <PositionBadge positionType={result.positionType} gender={p?.gender} />
      </div>
      <div className={`w-full flex flex-col items-center justify-center gap-1 ${platformColors[place]} ${platformHeights[place]}`}>
        <div className={`font-display text-4xl leading-none ${placeColors[place]}`}>{place}.</div>
        {result.gunDurationMs && (
          <div className="font-mono text-xs font-bold text-apex-yellow-bright">{formatDuration(result.gunDurationMs)}</div>
        )}
        {!result.gunDurationMs && (
          <div className="font-mono text-xs text-apex-muted">na trasie</div>
        )}
      </div>
    </div>
  )
}
