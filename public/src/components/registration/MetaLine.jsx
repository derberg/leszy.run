// „BIEG DZIECI 1 KM · DZIECI 2015–2017 · START 09:00”. A range („2015–2017”) is kept on one
// line: at 390 px it broke at its dash („2015–” / „2017”). Other parts wrap as text does, so a
// long competition name never pushes the page sideways. Empty parts are dropped.
const RANGE = /\d\s*[–-]\s*\d/

export default function MetaLine({ parts, className = 'block font-mono text-[13px] text-apex-muted uppercase' }) {
  const shown = (parts ?? []).filter(Boolean)
  return (
    <span className={className}>
      {shown.map((p, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {RANGE.test(p) ? <span className="whitespace-nowrap">{p}</span> : p}
        </span>
      ))}
    </span>
  )
}
