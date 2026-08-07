import { InfoTooltip } from './InfoTooltip.jsx'

// The status column sits at the right edge of a horizontally-scrollable table,
// so these anchor right and are portalled out of the clipping container.
function StatusTooltip({ label, children }) {
  return <InfoTooltip label={label} align="right">{children}</InfoTooltip>
}

export function PositionBadge({ positionType, gender }) {
  if (positionType === 'final') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest text-apex-yellow whitespace-nowrap">
        Na mecie
      </span>
    )
  }
  if (positionType === 'dnf') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest text-apex-red whitespace-nowrap inline-flex items-center">
        DNF
        <StatusTooltip label="DNF">
          <strong>DNF</strong> (Did Not Finish) — zawodnik wystartował, ale nie ukończył biegu.
          Przerwał trasę przed metą.
        </StatusTooltip>
      </span>
    )
  }
  if (positionType === 'dns') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest text-apex-muted whitespace-nowrap inline-flex items-center">
        DNS
        <StatusTooltip label="DNS">
          <strong>DNS</strong> (Did Not Start) — zawodnik zapisał się na bieg, ale nie
          pojawił się na starcie.
        </StatusTooltip>
      </span>
    )
  }
  if (positionType === 'dsq') {
    return (
      <span className="text-xs font-bold uppercase tracking-widest text-apex-red whitespace-nowrap inline-flex items-center">
        DSQ
        <StatusTooltip label="DSQ">
          <strong>DSQ</strong> (Disqualified) — zawodnik został zdyskwalifikowany
          (np. za złamanie regulaminu, skrócenie trasy, nieprawidłowy numer startowy).
        </StatusTooltip>
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
