import { Link } from 'react-router-dom'

// The strip under the navbar on RA1b, RA2, RA4 and RA5: a way back and where you are.
// `back` is a link ({ to, label }) or, inside one page's steps, a button ({ onClick, label }).
const backCls = 'min-h-11 flex items-center text-base text-apex-muted hover:text-apex-text-bright whitespace-nowrap'

export default function PageTop({ back, right }) {
  return (
    <div className="flex justify-between items-center gap-3 border-b border-apex-border pb-2">
      {back?.onClick
        ? <button type="button" onClick={back.onClick} className={backCls}>← {back.label}</button>
        : back
          ? <Link to={back.to} className={backCls}>← {back.label}</Link>
          : <span />}
      {right && <span className="font-mono text-xs text-apex-muted uppercase text-right truncate">{right}</span>}
    </div>
  )
}
