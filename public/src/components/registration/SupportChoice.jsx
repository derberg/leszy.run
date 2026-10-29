import { SUPPORT_QUESTION, SUPPORT_REASON } from '../../lib/checkout.js'

// RA4's required LESZY.RUN 2% question: two buttons, neither pressed until the
// runner presses one (Art. 10 ustawy o prawach konsumenta: nothing
// preselected). `options` come from checkoutModel(); the page keeps „Zapłać”
// disabled until a choice is made.
export default function SupportChoice({ options, onChoose, disabled = false }) {
  return (
    <div role="group" aria-labelledby="support-question" className="flex flex-col gap-2 py-2.5 border-b border-apex-border" data-testid="support-choice">
      <span id="support-question" className="text-base leading-snug text-apex-text-bright">
        <span className="text-apex-red" aria-hidden="true">*</span> {SUPPORT_QUESTION} <span className="text-apex-muted">{SUPPORT_REASON}</span>
      </span>
      <div className="flex gap-1.5">
        {options.map((o) => (
          <button key={String(o.value)} type="button" aria-pressed={o.pressed} disabled={disabled}
            onClick={() => onChoose(o.value)}
            className={`flex-1 min-w-0 min-h-11 px-1.5 border bg-apex-surface font-mono text-xs sm:text-sm whitespace-nowrap disabled:opacity-40 ${o.pressed ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text hover:border-apex-yellow-dim'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
