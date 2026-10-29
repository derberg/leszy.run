import { useState } from 'react'
import { callFunction } from '../../lib/auth.js'
import { canRemind, consentTag, remindLabel } from '../../lib/consentTag.js'

// One registered person on RA5 (Zamowienie for a paid order, Zapisano for a free one): the
// name, competition · group · start, and in a group the regulamin tag of RB4 („✓ REGULAMIN” /
// „✓ OPIEKUN” / „CZEKA NA ZGODĘ”). An added adult still awaiting gets „Wyślij przypomnienie
// do <imię> →” (remind-consent: a new link, the old one stops working; 3 per registration per
// 24 h, the server's 429 wording shown as is). A 409 means the person accepted (or the link
// ended) meanwhile, so the page reads the people again (`onStale`).

const TAG_CLS = {
  accepted: 'border-apex-yellow-dim text-apex-yellow',
  guardian: 'border-apex-yellow-dim text-apex-yellow',
  awaiting: 'border-apex-cyan text-apex-cyan',
}

function RemindConsent({ registrationId, firstName, onStale }) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)

  async function send() {
    setBusy(true)
    setError(null)
    setSent(false)
    try {
      await callFunction('remind-consent', { registrationId })
      setSent(true)
    } catch (err) {
      setError(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
      if (err.status === 409) onStale?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1 pt-2.5 mt-2.5 border-t border-apex-border">
      <button type="button" onClick={send} disabled={busy} data-testid="remind-consent"
        className="self-start max-w-full truncate whitespace-nowrap text-left text-base font-bold text-apex-yellow hover:text-apex-yellow-bright underline-offset-2 hover:underline disabled:opacity-60 disabled:cursor-wait">
        {remindLabel(firstName)}
      </button>
      <span className="text-sm text-apex-text-bright empty:hidden" aria-live="polite" data-testid="remind-status">
        {sent ? 'Przypomnienie wysłane.' : ''}
      </span>
      {error && <span className="text-sm text-apex-red" role="alert">{error}</span>}
    </div>
  )
}

/**
 * @param {{ person: { role?, consentState?, firstName? }, registrationId?: string, name: string,
 *   meta: string, showTag: boolean, testId: string, onStale?: () => void }} p
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
            {tag.label}
          </span>
        )}
      </div>
      <span className="block font-mono text-[13px] text-apex-muted uppercase">{meta}</span>
      {tag && canRemind(person) && registrationId && person.firstName && (
        <RemindConsent registrationId={registrationId} firstName={person.firstName} onStale={onStale} />
      )}
    </div>
  )
}
