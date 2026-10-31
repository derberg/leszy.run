import { useRef, useState } from 'react'
import { callFunction } from '../../lib/auth.js'
import { canRemind, consentTag, remindAriaLabel, remindError, remindLabel } from '../../lib/consentTag.js'
import MetaLine from './MetaLine.jsx'

// One registered person on RA5 (Zamowienie for a paid order, Zapisano for a free one): the
// name, competition · group · start, and in a group the regulamin tag of RB4 („✓ REGULAMIN” /
// „✓ OPIEKUN” / „CZEKA NA ZGODĘ”). An added adult still awaiting
// gets „Wyślij przypomnienie →” in their row (remind-consent: a new link, the old one stops
// working; 3 per registration per 24 h). After a send the control stays off for the page's
// life: a second click would spend another of the 3 and kill the link just sent. A 409 means
// the person accepted (or the link ended) meanwhile, so the page reads the people again.

const TAG_CLS = {
  accepted: 'border-apex-yellow-dim text-apex-yellow',
  guardian: 'border-apex-yellow-dim text-apex-yellow',
  awaiting: 'border-apex-cyan text-apex-cyan-text',
}

function RemindConsent({ registrationId, name, onStale }) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)

  async function send() {
    if (inFlight.current || sent) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await callFunction('remind-consent', { registrationId })
      setSent(true)
    } catch (err) {
      setError(remindError(err))
      if (err.status === 409) onStale?.()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1 pt-2.5 mt-2.5 border-t border-apex-border">
      <button type="button" onClick={send} disabled={busy || sent} data-testid="remind-consent" aria-label={remindAriaLabel(name)}
        className="self-start whitespace-nowrap text-left text-base font-bold text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default">
        {remindLabel()}
      </button>
      {/* Always in the tree, so its text is announced when it changes. */}
      <span className="text-sm text-apex-text-bright" role="status" aria-live="polite" data-testid="remind-status">
        {sent ? 'Przypomnienie wysłane.' : ''}
      </span>
      {error && <span className="text-sm text-apex-red" role="alert" data-testid="remind-error">{error}</span>}
    </div>
  )
}

/**
 * @param {{ person: { role?, consentState?, mine? }, registrationId?: string, name: string,
 *   meta: Array<string|null>, showTag: boolean, testId: string, onStale?: () => void }} p
 */
export default function RegisteredPerson({ person, registrationId, name, meta, showTag, testId, onStale }) {
  const tag = showTag ? consentTag(person) : null
  return (
    <div className="border border-apex-border-mid bg-apex-surface p-3.5" data-testid={testId}>
      <div className="flex justify-between items-start gap-3">
        <span className="min-w-0 block text-lg font-bold text-apex-text-bright [overflow-wrap:anywhere]">{name}</span>
        {tag && (
          <span className={`shrink-0 mt-0.5 border px-1.5 py-0.5 font-mono text-xs uppercase whitespace-nowrap ${TAG_CLS[tag.kind]}`}
            data-testid="consent-tag" data-kind={tag.kind}>
            <span aria-hidden="true">{tag.label}</span>
            <span className="sr-only">{tag.srLabel}</span>
          </span>
        )}
      </div>
      <MetaLine parts={meta} />
      {tag && canRemind(person) && registrationId && (
        <RemindConsent registrationId={registrationId} name={name} onStale={onStale} />
      )}
    </div>
  )
}
