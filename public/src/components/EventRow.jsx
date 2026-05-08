import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReportEventModal from './ReportEventModal.jsx'
import { slugify } from '../lib/slugify.js'

const baseTag = 'font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border uppercase'
const typeTagClass = `${baseTag} border-apex-cyan/30 text-apex-cyan`
const distTagClass = `${baseTag} border-[rgba(187,221,0,0.3)] text-apex-yellow-dim`

const TYPE_LABELS = {
  trail: 'trail',
  nocny: 'nocny',
  ocr: 'OCR',
  nordic: 'nordic walking',
  ultra: 'ultramaraton',
  charytatywny: 'charytatywny',
  uliczny: 'uliczny',
}

function TypeTag({ label }) {
  if (!label) return null
  return <span className={typeTagClass}>{TYPE_LABELS[label] || label}</span>
}

function DistTag({ label }) {
  if (!label) return null
  return <span className={distTagClass}>{label}</span>
}

function extractCity(location) {
  if (!location) return null
  const cleaned = location.split(/[;:|]/)[0].trim()
  if (/^\d{4}/.test(cleaned)) return null
  if (cleaned.length > 40) return null
  const city = cleaned.split(',')[0].trim()
  return city || null
}

export default function EventRow({ event }) {
  const [showReport, setShowReport] = useState(false)
  const navigate = useNavigate()
  const dateStr = new Date(event.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })
  const isLeszyrun = !!event.leszyrun_event_id

  const handleClick = () => {
    if (isLeszyrun && event.slug) {
      window.location.href = `/events/${event.slug}`
    } else {
      navigate(`/kalendarz/${slugify(event.name, event.date)}`)
    }
  }

  const handleReport = (e) => {
    e.stopPropagation()
    setShowReport(true)
  }

  const city = extractCity(event.location)
  const types = (event.event_type || []).filter(t => t !== 'bieg')
  const MAX_DISTANCES_SHOWN = 4
  const distancesArr = event.distances || []
  const distanceLabel = distancesArr.length === 0
    ? null
    : distancesArr.length > MAX_DISTANCES_SHOWN
      ? `${distancesArr.slice(0, MAX_DISTANCES_SHOWN).join(' / ')} +${distancesArr.length - MAX_DISTANCES_SHOWN}`
      : distancesArr.join(' / ')
  const regClosed = event.registration_deadline
    && new Date(event.registration_deadline + 'T23:59:59') < new Date()

  return (
    <>
      <div
        onClick={handleClick}
        className={`px-3 md:px-4 py-3 md:py-3.5 border mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all cursor-pointer group ${isLeszyrun ? 'bg-apex-yellow/[0.06] border-l-[4px] border-l-apex-yellow border-t-apex-yellow/20 border-r-apex-yellow/20 border-b-apex-yellow/20' : 'bg-apex-surface border-apex-border'}`}
        role="link"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      >
        {/* Desktop: title column gets minimum width; badges column shrinks and wraps */}
        <div className="hidden md:grid grid-cols-[90px_minmax(260px,1fr)_minmax(0,auto)] items-center gap-4">
          <div className="font-mono text-[13px] font-semibold text-apex-yellow">{dateStr}</div>
          <div className="min-w-0">
            <div className="font-display font-bold text-[17px] tracking-wide uppercase text-apex-text-bright truncate">{event.name}</div>
            {city && (
              <div className="text-[13px] text-apex-muted mt-0.5">{city}</div>
            )}
          </div>
          <div className="flex gap-1.5 items-center min-w-0 max-w-[55%] justify-end">
            <div className="flex gap-1.5 items-center flex-wrap justify-end min-w-0">
              {regClosed && (
                <span className={`${baseTag} border-apex-red/30 text-apex-red`}>Zapisy zamknięte</span>
              )}
              {types.map(t => <TypeTag key={t} label={t} />)}
              <DistTag label={distanceLabel} />
              {isLeszyrun && (
                <span className="font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20">
                  LESZY.RUN
                </span>
              )}
            </div>
            <button onClick={handleReport} title="Zgłoś nieprawidłowe dane wydarzenia"
              className="text-apex-muted hover:text-apex-yellow focus:text-apex-yellow transition-colors px-2 py-1 ml-1 flex items-center gap-1.5 text-[10px] font-mono font-semibold tracking-wide uppercase border border-apex-border hover:border-apex-yellow/40 shrink-0"
              aria-label="Zgłoś nieprawidłowe dane wydarzenia">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
              <span>Zgłoś poprawkę</span>
            </button>
          </div>
        </div>

        {/* Mobile: stacked layout */}
        <div className="md:hidden flex gap-2">
          <span className="font-mono text-[12px] font-semibold text-apex-yellow shrink-0 pt-0.5">{dateStr}</span>
          <div className="min-w-0 flex-1">
            <span className="font-display font-bold text-[14px] tracking-wide uppercase text-apex-text-bright leading-tight">{event.name}</span>
            {city && (
              <div className="text-[12px] text-apex-muted mt-0.5">{city}</div>
            )}
            {(types.length > 0 || distanceLabel || regClosed) && (
              <div className="flex gap-1 mt-1.5 flex-wrap">
                {regClosed && (
                  <span className={`${baseTag} border-apex-red/30 text-apex-red`}>Zapisy zamknięte</span>
                )}
                {types.map(t => <TypeTag key={t} label={t} />)}
                <DistTag label={distanceLabel} />
                {isLeszyrun && (
                  <span className="font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20">
                    LESZY.RUN
                  </span>
                )}
              </div>
            )}
            <button onClick={handleReport}
              className="mt-2 text-apex-muted active:text-apex-yellow transition-colors px-2 py-1 inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold tracking-wide uppercase border border-apex-border"
              aria-label="Zgłoś nieprawidłowe dane wydarzenia">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
              <span>Zgłoś poprawkę</span>
            </button>
          </div>
        </div>
      </div>
      {showReport && <ReportEventModal event={event} onClose={() => setShowReport(false)} />}
    </>
  )
}
