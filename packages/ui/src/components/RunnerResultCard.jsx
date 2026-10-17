import { anonymizedName } from '../lib/anonymizedName.js'

const STATUS = {
  dns: { label: 'DNS', note: 'Nie wystartował(a).', tone: 'text-apex-muted' },
  dnf: { label: 'DNF', note: 'Nie ukończył(a) biegu.', tone: 'text-apex-red' },
  dsq: { label: 'DSQ', note: 'Zdyskwalifikowany(a).', tone: 'text-apex-red' },
}

/**
 * The one runner a results-page search found: place and time once they have
 * finished, the last checkpoint passed while they are on course.
 *
 * @param {object} participant - { bibNumber, firstName, lastName, deleted_at }
 * @param {string} categoryName
 * @param {object|null} summary - from runnerSummary(); null when the runner has no result yet
 * @param {Function} formatDuration - (ms) => display string
 * @param {Function} [onShare]
 * @param {string} [shareLabel] - button text, e.g. "Skopiowano link" after a copy
 * @param {boolean} [raceOver] - the run has ended: nothing more will arrive for this runner
 */
export function RunnerResultCard({ participant, categoryName, summary, formatDuration, onShare, shareLabel = 'Udostępnij', raceOver = false }) {
  const { displayName, isAnonymized } = anonymizedName(participant)
  const type = summary?.positionType
  const finished = type === 'final'
  const status = STATUS[type]
  const onCourse = !raceOver && (type === 'checkpoint' || type === 'started')
  const noResult = !finished && !status && !onCourse

  const frame = finished
    ? 'border-apex-yellow bg-apex-yellow/10'
    : onCourse ? 'border-apex-cyan bg-apex-cyan/10' : 'border-apex-border-bright bg-apex-surface'

  return (
    <div className={`border-2 ${frame} p-3.5 flex flex-col gap-2.5`}>
      <div className="flex items-center gap-3.5">
        {finished && summary.position != null && (
          <span className="font-display font-extrabold text-5xl leading-none text-apex-yellow">{summary.position}.</span>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <span className={`text-xl font-bold truncate ${isAnonymized ? 'italic text-apex-muted' : 'text-apex-text-bright'}`}>{displayName}</span>
          <span className="font-mono text-xs text-apex-muted">#{participant.bibNumber} · {categoryName}</span>
        </div>
        {onCourse && (
          <span className="flex items-center gap-1.5 font-mono text-xs font-bold tracking-widest uppercase text-apex-cyan whitespace-nowrap">
            <span className="inline-block w-2 h-2 rounded-full bg-apex-cyan animate-pulse" />
            Na trasie
          </span>
        )}
        {status && (
          <span className={`font-mono text-xs font-bold tracking-widest uppercase ${status.tone}`}>{status.label}</span>
        )}
      </div>

      {finished && (
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-mono text-3xl font-bold text-apex-yellow">{formatDuration(summary.gunDurationMs ?? summary.durationMs)}</span>
          {summary.gunDurationMs != null && summary.durationMs != null && summary.durationMs !== summary.gunDurationMs && (
            <span className="font-mono text-sm text-apex-text">netto {formatDuration(summary.durationMs)}</span>
          )}
        </div>
      )}

      {onCourse && summary.lastCheckpoint?.splitMs != null && (
        <div className="text-[15px] text-apex-text-bright">
          <span className="text-apex-cyan font-semibold">{summary.lastCheckpoint.name}</span>{' '}
          <span className="font-mono">{formatDuration(summary.lastCheckpoint.splitMs)}</span>
        </div>
      )}
      {onCourse && <div className="text-sm text-apex-text">Czas pojawi się tu sam po przekroczeniu mety.</div>}

      {status && <div className="text-sm text-apex-text">{status.note}</div>}
      {noResult && (
        <div className="text-sm text-apex-text">
          {raceOver ? 'Brak wyniku.' : 'Jeszcze nie wystartował(a). Czas pojawi się tu sam.'}
        </div>
      )}

      {onShare && (
        <button
          type="button"
          onClick={onShare}
          className="self-start h-10 px-3.5 border border-apex-text-bright text-apex-text-bright text-xs font-bold tracking-widest uppercase hover:bg-apex-text-bright hover:text-apex-bg transition-colors"
        >
          {shareLabel}
        </button>
      )}
    </div>
  )
}
