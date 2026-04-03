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
  const distanceLabel = (event.distances && event.distances.length > 0)
    ? event.distances.join(' / ')
    : null

  return (
    <>
      <div
        onClick={handleClick}
        className={`px-3 md:px-4 py-3 md:py-3.5 border mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all cursor-pointer group ${isLeszyrun ? 'bg-apex-yellow/[0.03] border-l-[3px] border-l-apex-yellow border-t-apex-border border-r-apex-border border-b-apex-border' : 'bg-apex-surface border-apex-border'}`}
        role="link"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      >
        {/* Desktop: single row grid */}
        <div className="hidden md:grid grid-cols-[90px_1fr_auto] items-center gap-4">
          <div className="font-mono text-[13px] font-semibold text-apex-yellow">{dateStr}</div>
          <div className="min-w-0">
            <div className="font-display font-bold text-[17px] tracking-wide uppercase text-apex-text-bright truncate">{event.name}</div>
            {city && (
              <div className="text-[13px] text-apex-muted mt-0.5">{city}</div>
            )}
          </div>
          <div className="flex gap-1.5 items-center flex-shrink-0">
            <div className="flex gap-1.5 items-center flex-wrap">
              {types.map(t => <TypeTag key={t} label={t} />)}
              <DistTag label={distanceLabel} />
              {isLeszyrun && (
                <span className="font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20">
                  LESZY.RUN
                </span>
              )}
            </div>
            <button onClick={handleReport} title="Zgłoś problem"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-apex-dim hover:text-apex-yellow transition-all p-1 ml-1"
              aria-label="Zgłoś problem z tym wydarzeniem">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile: stacked layout */}
        <div className="md:hidden flex gap-2">
          <span className="font-mono text-[12px] font-semibold text-apex-yellow shrink-0 pt-0.5">{dateStr}</span>
          <div className="min-w-0">
            <span className="font-display font-bold text-[14px] tracking-wide uppercase text-apex-text-bright leading-tight">{event.name}</span>
            {city && (
              <div className="text-[12px] text-apex-muted mt-0.5">{city}</div>
            )}
            {(types.length > 0 || distanceLabel) && (
              <div className="flex gap-1 mt-1.5 flex-wrap">
                {types.map(t => <TypeTag key={t} label={t} />)}
                <DistTag label={distanceLabel} />
                {isLeszyrun && (
                  <span className="font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20">
                    LESZY.RUN
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {showReport && <ReportEventModal event={event} onClose={() => setShowReport(false)} />}
    </>
  )
}
