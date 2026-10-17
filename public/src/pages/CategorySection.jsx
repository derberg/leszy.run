import { useState } from 'react'
import { Podium, CheckpointTrackingTable, estimatePositions } from '../ui/index.js'
import { useCategoryResults } from '../hooks/useCategoryResults.js'
import { formatDuration } from '../lib/formatDuration.js'


function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const GENDER_VIEWS = [
  { key: null, label: 'Open' },
  { key: 'M', label: 'Mężczyźni' },
  { key: 'K', label: 'Kobiety' },
]

function GenderTabs({ value, onChange }) {
  return (
    <div className="flex justify-center gap-1 mb-8">
      {GENDER_VIEWS.map(v => (
        <button
          key={v.key ?? 'open'}
          onClick={() => onChange(v.key)}
          className={`px-4 py-2 text-xs font-bold tracking-widest uppercase transition-colors border ${
            value === v.key
              ? 'bg-apex-yellow text-black border-apex-yellow'
              : 'text-apex-muted border-apex-border hover:text-apex-text'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

/**
 * @param {import('react').ReactNode} [afterPodium] - shown right under the podium
 *   (the event's partners on the results page)
 */
export default function CategorySection({ eventId, categoryId, afterPodium }) {
  const [gender, setGender] = useState(null)
  const { category, raceRun, results, checkpoints, observations } = useCategoryResults(eventId, categoryId)

  const filteredResults = gender
    ? results.filter(r => r.participant?.gender === gender)
    : results

  const enrichedResults = estimatePositions(filteredResults, checkpoints, observations)
  const top3 = enrichedResults.slice(0, 3)
  const animals = top3.map(r => r.participant?.emoji || '\u{1F3C3}')

  return (
    <div>
      <div className="text-center mb-6">
        <div className="font-display text-5xl tracking-widest uppercase text-apex-text-bright mb-1">
          {category?.name || '—'}
        </div>
{raceRun?.started_at && (
          <div className="text-apex-text text-sm">Start {formatTime(raceRun.started_at)}</div>
        )}
      </div>

      <GenderTabs value={gender} onChange={setGender} />

      {top3.length > 0 && (
        <div className="mb-10">
          <div className="font-display text-2xl tracking-widest uppercase text-apex-text text-center mb-6">Podium</div>
          <Podium top3={top3} animals={animals} formatDuration={formatDuration} />
        </div>
      )}

      {afterPodium && <div className="mb-10">{afterPodium}</div>}

      {enrichedResults.length > 0 && (
        <div className="mb-8">
          <div className="font-display text-xl tracking-widest uppercase text-apex-text mb-3">Wyniki</div>
          <CheckpointTrackingTable
            results={enrichedResults}
            checkpoints={checkpoints}
            observations={observations}
            gunStartedAt={raceRun?.started_at}
            formatTime={formatTime}
            formatDuration={formatDuration}
          />
        </div>
      )}

      {!raceRun && (
        <div className="text-center py-12 text-apex-text">
          <div className="font-display text-4xl uppercase tracking-widest mb-2">Oczekiwanie</div>
          <div className="text-sm">Wyscig jeszcze nie wystartowal. Ta strona aktualizuje sie automatycznie.</div>
        </div>
      )}
    </div>
  )
}
