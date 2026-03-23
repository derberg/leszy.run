const baseTag = 'font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border uppercase'
const typeTagClass = `${baseTag} border-[rgba(0,191,239,0.3)] text-[#00BFEF]`       // cyan for event type
const distTagClass = `${baseTag} border-[rgba(187,221,0,0.3)] text-apex-yellow-dim`  // yellow for distance

function TypeTag({ label }) {
  if (!label) return null
  return <span className={typeTagClass}>{label}</span>
}

function DistTag({ label }) {
  if (!label) return null
  return <span className={distTagClass}>{label}</span>
}

function extractCity(location) {
  if (!location) return null
  // Take first meaningful part before colon, comma, semicolon, or pipe
  const cleaned = location.split(/[;:|]/)[0].trim()
  // Remove date patterns, zip codes, long descriptions
  if (/^\d{4}/.test(cleaned)) return null
  if (cleaned.length > 40) return null
  // Remove trailing comma content
  const city = cleaned.split(',')[0].trim()
  return city || null
}

export default function EventRow({ event }) {
  const dateStr = new Date(event.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })
  const isLeszyrun = !!event.leszyrun_event_id

  const handleClick = () => {
    if (isLeszyrun && event.slug) {
      window.location.href = `/events/${event.slug}`
    } else if (event.registration_url) {
      window.open(event.registration_url, '_blank', 'noopener')
    }
  }

  const city = extractCity(event.location)
  const types = event.event_type || []
  const typeLabel = types.length > 0 ? types[0] : null
  const distanceLabel = (event.distances && event.distances.length > 0)
    ? event.distances.join(' / ')
    : null

  return (
    <div
      onClick={handleClick}
      className="grid grid-cols-[70px_1fr] md:grid-cols-[90px_1fr_auto] items-center gap-2 md:gap-4 px-3 md:px-4 py-3 md:py-3.5 bg-apex-surface border border-apex-border mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all cursor-pointer"
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className="font-mono text-[13px] font-semibold text-apex-yellow">{dateStr}</div>

      <div className="min-w-0">
        <div className="font-display font-bold text-[15px] md:text-[17px] tracking-wide uppercase text-apex-text-bright truncate">{event.name}</div>
        {city && <div className="text-[13px] text-apex-muted mt-0.5">{city}</div>}
      </div>

      <div className="hidden md:flex gap-1.5 items-center flex-shrink-0">
        <TypeTag label={typeLabel} />
        <DistTag label={distanceLabel} />
        {isLeszyrun && (
          <span className="font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20">
            LESZY.RUN
          </span>
        )}
      </div>
    </div>
  )
}
