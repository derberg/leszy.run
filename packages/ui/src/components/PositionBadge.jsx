export function PositionBadge({ positionType, gender }) {
  if (positionType === 'final') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest text-apex-yellow whitespace-nowrap">
        Na mecie
      </span>
    )
  }
  if (positionType === 'not-started') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest text-apex-muted whitespace-nowrap">
        Oczekuje
      </span>
    )
  }
  return (
    <span className="text-xs font-bold uppercase tracking-widest text-apex-cyan whitespace-nowrap flex items-center gap-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-cyan animate-pulse" />
      Na Trasie
    </span>
  )
}
