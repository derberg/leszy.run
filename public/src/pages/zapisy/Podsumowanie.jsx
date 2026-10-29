import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearAuthCache } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import { forgetPublicRegistrationEvent } from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction } from '../../lib/auth.js'
import { checkoutModel } from '../../lib/checkout.js'
import { registerBody } from '../../lib/personFormModel.js'
import PageTop from '../../components/registration/PageTop.jsx'
import SupportChoice from '../../components/registration/SupportChoice.jsx'
import { primaryBtn } from '../../components/registration/ui.js'

// RA4 (paid events): the person's line, „Opłaty startowe”, the required
// LESZY.RUN 2% choice (nothing preselected, „Zapłać” disabled until chosen),
// the dpay fee and „Razem”. „Zapłać” calls create-order with register-free's
// body plus the choice and the total shown here (the server only compares it
// with its own), then hands the browser to dpay. The amounts are money.js's,
// the same module the server uses.

export const orderPath = (orderId) => `/zamowienie/${orderId}`

// Refusals that belong to the form or the code step (ZapisView shows them there).
const BACK_TO_FORM = new Set(['invalid_person', 'email_retired', 'duplicate', 'consents_required', 'consents_changed'])

const row = 'flex justify-between gap-2.5 py-2 border-b border-apex-border text-base'

/**
 * @param {{ raw: object, categoryId: string, competitionName: string, priceGrosze: number, open: boolean,
 *   person: object, ageGroupLabel: string|null, consents: object[], code: string|null,
 *   onBack: () => void, onFailure: (err: Error) => void }} p
 */
export default function Podsumowanie({ raw, categoryId, competitionName, priceGrosze, open, person, ageGroupLabel, consents, code, onBack, onFailure }) {
  const navigate = useNavigate()
  const [choice, setChoice] = useState(null)
  const [price, setPrice] = useState(priceGrosze)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const m = checkoutModel({ entryPrices: [price], choice, busy, closed: !open })

  // The form above it was scrolled to its end: the summary starts at its top.
  useEffect(() => { window.scrollTo(0, 0) }, [])

  function settled() {
    // create-order set the session cookie: drop whatever the browser cached about the previous visitor.
    clearAuthCache()
    clearFavoritesCache()
    clearNotificationsCache()
    forgetPublicRegistrationEvent(raw.slug)
  }

  async function pay() {
    if (m.payDisabled) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await callFunction('create-order', {
        ...registerBody({ categoryId, person, consents, code }),
        supportChoice: m.supportChoice,
        displayedTotal: m.displayedTotal,
      })
      settled()
      if (r.data?.redirectUrl) {
        window.location.assign(r.data.redirectUrl)
        return
      }
      navigate(orderPath(r.data.orderId), { replace: true })
    } catch (err) {
      setBusy(false)
      if (err.code === 'pending_order' && err.orderId) {
        settled()
        navigate(orderPath(err.orderId), { replace: true })
        return
      }
      if (err.code === 'price_changed') {
        if (Number.isSafeInteger(err.amounts?.entryTotal)) setPrice(err.amounts.entryTotal)
        setMessage(err.message)
        return
      }
      if (err.status === 401 || BACK_TO_FORM.has(err.code)) {
        onFailure(err)
        return
      }
      setMessage(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
    }
  }

  return (
    <div className="flex flex-col gap-[18px]" data-testid="checkout">
      <PageTop back={{ label: 'Wróć', onClick: onBack }} right="KROK 2/3" />
      <h1 className="font-display font-extrabold text-[32px] leading-none uppercase text-apex-text-bright">Podsumowanie</h1>
      <div>
        <div className={row} data-testid="checkout-line">
          <span className="min-w-0">
            <span className="block text-apex-text-bright text-[17px]">{person.firstName} {person.lastName}</span>
            <span className="block font-mono text-[13px] text-apex-muted uppercase">{[competitionName, ageGroupLabel].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="font-mono text-apex-text-bright whitespace-nowrap">{m.entryLabel}</span>
        </div>
      </div>
      <div data-testid="checkout-amounts">
        <div className={row}><span>Opłaty startowe</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{m.entryLabel}</span></div>
        {m.askSupport && <SupportChoice options={m.options} onChoose={setChoice} disabled={busy} />}
        {m.askSupport && choice === true && (
          <div className={row}><span>Wsparcie LESZY.RUN</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{m.supportLabel}</span></div>
        )}
        <div className={row}><span>Obsługa płatności dpay · 0,9%</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{m.paymentFeeLabel}</span></div>
        <div className="flex justify-between gap-2.5 py-2 text-xl font-bold text-apex-text-bright" data-testid="checkout-total">
          <span>Razem</span><span className="font-mono text-apex-yellow whitespace-nowrap">{m.totalLabel}</span>
        </div>
      </div>
      {!open && <p className="text-apex-red text-base">Zapisy są zamknięte.</p>}
      {message && <p className="text-apex-red text-base" role="alert">{message}</p>}
      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={pay} disabled={m.payDisabled} className={primaryBtn} data-testid="pay">
          {busy ? 'Chwileczkę…' : 'Zapłać'}
        </button>
        {m.hint && <span className="text-[13px] text-apex-muted text-center" data-testid="support-hint">{m.hint}</span>}
      </div>
      <p className="text-sm text-apex-muted">
        Płatność obsługuje dpay. Opłaty startowe pobieramy w imieniu i na rzecz organizatora: {raw.club?.name ?? 'klubu'}.
      </p>
    </div>
  )
}
