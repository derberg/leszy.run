import { Link } from 'react-router-dom'

// The strip under the navbar on RA1b, RA2 and RA5: a way back and where you are.
export default function PageTop({ back, right }) {
  return (
    <div className="flex justify-between items-center gap-3 border-b border-apex-border pb-2">
      {back
        ? <Link to={back.to} className="min-h-11 flex items-center text-base text-apex-muted hover:text-apex-text-bright whitespace-nowrap">← {back.label}</Link>
        : <span />}
      {right && <span className="font-mono text-xs text-apex-muted uppercase text-right truncate">{right}</span>}
    </div>
  )
}
