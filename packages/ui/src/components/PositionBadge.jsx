export function PositionBadge({ positionType, gender }) {
  if (positionType === 'final') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest px-1.5 py-0.5 border border-apex-yellow text-apex-yellow">
        Na mecie
      </span>
    )
  }
  if (positionType === 'not-started') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest px-1.5 py-0.5 border border-apex-muted text-apex-muted">
        Oczekuje
      </span>
    )
  }
  return (
    <span className="text-xs font-bold uppercase tracking-widest px-1.5 py-0.5 border border-apex-cyan text-apex-cyan flex items-center gap-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-apex-cyan animate-pulse" />
      Na Trasie
    </span>
  )
}
