const TAG_STYLES = {
  trail: 'border-[rgba(74,138,66,0.4)] text-[#4A8A42]',
  nocny: 'border-[rgba(0,191,239,0.3)] text-[#00BFEF]',
  charytatywny: 'border-[rgba(187,221,0,0.3)] text-apex-yellow',
  ocr: 'border-[rgba(239,68,68,0.3)] text-[#EF4444]',
  nordic: 'border-[rgba(187,221,0,0.2)] text-apex-yellow-dim',
  uliczny: 'border-apex-border-mid text-apex-muted',
}

function EventTag({ type }) {
  const style = TAG_STYLES[type] || TAG_STYLES.uliczny
  return (
    <span className={`font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border ${style} uppercase`}>
      {type}
    </span>
  )
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

  return (
    <div
      onClick={handleClick}
      className="grid grid-cols-[70px_1fr] md:grid-cols-[90px_1fr_auto_auto_auto] items-center gap-2 md:gap-4 px-3 md:px-4 py-3 md:py-3.5 bg-apex-surface border border-apex-border mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all cursor-pointer"
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className="font-mono text-[13px] font-semibold text-apex-yellow">{dateStr}</div>

      <div className="min-w-0">
        <div className="font-display font-bold text-[15px] md:text-[17px] tracking-wide uppercase text-apex-text-bright truncate">{event.name}</div>
        <div className="text-[13px] text-apex-muted mt-0.5 flex gap-2 items-center">
          <span>{event.location}{event.voivodeship ? `, ${event.voivodeship}` : ''}</span>
          {event.source && <span>&middot; {event.source}</span>}
        </div>
      </div>

      <div className="hidden md:flex gap-1 flex-shrink-0">
        {(event.event_type || []).map(t => <EventTag key={t} type={t} />)}
      </div>

      <div className="hidden md:block font-mono text-xs text-apex-text flex-shrink-0 text-right">
        {(event.distances || []).join(' / ')}
      </div>

      {isLeszyrun ? (
        <span className="hidden md:block font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20 flex-shrink-0">
          LESZY.RUN
        </span>
      ) : <div className="hidden md:block" />}
    </div>
  )
}
