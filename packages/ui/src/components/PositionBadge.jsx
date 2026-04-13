import { useState } from 'react'

function StatusTooltip({ children }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-apex-muted text-apex-muted text-[9px] hover:border-apex-yellow hover:text-apex-yellow cursor-pointer leading-none"
      >
        ?
      </button>
      {open && (
        <span className="absolute z-50 top-5 right-0 w-56 text-left bg-apex-bg border border-apex-yellow p-2 text-xs font-normal normal-case tracking-normal text-apex-text shadow-lg whitespace-normal">
          {children}
        </span>
      )}
    </span>
  )
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
        <StatusTooltip>
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
        <StatusTooltip>
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
        <StatusTooltip>
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
