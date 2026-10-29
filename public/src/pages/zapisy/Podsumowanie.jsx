import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearAuthCache } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import { forgetPublicRegistrationEvent } from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction } from '../../lib/auth.js'
import { releaseLeaveGuard } from '../../lib/leaveGuard.js'
import { backToForm, checkoutModel, newOrderPayable, PAYING_CLOSED_TEXT, PAYING_CLOSES_BEFORE_MS, repriceLines } from '../../lib/checkout.js'
import { formatPln } from '@registration/money.js'
import PageTop from '../../components/registration/PageTop.jsx'
import SupportChoice from '../../components/registration/SupportChoice.jsx'
import { primaryBtn } from '../../components/registration/ui.js'

// RA4 (paid events): one line per person (name, competition · group, that competition's
// price), „Opłaty startowe” over every line, the required
// LESZY.RUN 2% choice (nothing preselected, „Zapłać” disabled until chosen),
// the dpay fee and „Razem”. „Zapłać” calls create-order with register-free's
// body plus the choice and the total shown here (the server only compares it
// with its own), then hands the browser to dpay. The amounts are money.js's,
// the same module the server uses. The person reaches it with their own
// session (the code step opened it), so no code is sent here.
//
// Before leaving for dpay the current history entry becomes the order page, so
// Back from dpay lands on /zamowienie/<id> (pending, with „Zapłać”), never on
// this step frozen at „Chwileczkę…” or on an empty form. A page restored from
// the back/forward cache reloads, which then shows that order page.
// A new paid order stops one hour before closes_at (plan ruling 7), as
// create_order does: „Zapłać” is off from then, with the server's wording.
// A price_changed answer re-prices every line from the server's per-person prices
// (repriceLines), never a new total beside stale lines; one the lines cannot be priced
// from starts again from a fresh event page. A refusal about a person (their card's
// `index`, a full competition the server names, the generic group refusal, no session)
// goes back to the form, which routes it to the card (backToForm, groupFailure).

export const orderPath = (orderId) => `/zamowienie/${orderId}`

const row = 'flex justify-between gap-2.5 py-2 border-b border-apex-border text-base'

/**
 * @param {{ raw: object, open: boolean, lines: Array<{ key, name, competitionName, ageGroupLabel, priceGrosze }>,
 *   body: object (groupDraft's toRequest, without a code), choice: boolean|null,
 *   onChoice: (v: boolean) => void, onBack: () => void, onFailure: (err: Error) => void }} p
 */
export default function Podsumowanie({ raw, open, lines: formLines, body, choice, onChoice, onBack, onFailure }) {
  const navigate = useNavigate()
  // The lines as the server last priced them: the form's, until a price_changed re-prices them.
  const [lines, setLines] = useState(formLines)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [, tick] = useState(0)
  const payable = newOrderPayable(raw.closesAt)
  const m = checkoutModel({ entryPrices: lines.map((l) => l.priceGrosze), choice, busy, closed: !open || !payable })

  // The form above it was scrolled to its end: the summary starts at its top.
  useEffect(() => { window.scrollTo(0, 0) }, [])

  // A page left open into the last hour turns „Zapłać” off when it starts.
  useEffect(() => {
    const until = Date.parse(raw.closesAt ?? '') - PAYING_CLOSES_BEFORE_MS - Date.now()
    if (!(until > 0) || until > 2 ** 31 - 1) return undefined
    const t = setTimeout(() => tick((n) => n + 1), until + 50)
    return () => clearTimeout(t)
  }, [raw.closesAt])

  // Restored from the back/forward cache after leaving for dpay: the address is
  // already the order page, so load it.
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) window.location.reload() }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

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
        ...body,
        supportChoice: m.supportChoice,
        displayedTotal: m.displayedTotal,
      })
      settled()
      if (r.data?.redirectUrl) {
        // Back from dpay must land on the order, not on this step (React Router does not
        // see replaceState, and this page is left at once).
        window.history.replaceState(null, '', orderPath(r.data.orderId))
        // The group form's leave guard must not hold up the payment (Zapis.jsx).
        releaseLeaveGuard()
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
        const repriced = repriceLines(lines, err.amounts)
        if (repriced) {
          setLines(repriced)
          setMessage(err.message)
          return
        }
        // The server could not say the new price: start again from a fresh event page.
        forgetPublicRegistrationEvent(raw.slug)
        releaseLeaveGuard()
        window.location.assign(`/events/${raw.slug}`)
        return
      }
      if (backToForm(err)) {
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
        {lines.map((l) => (
          <div key={l.key} className={row} data-testid="checkout-line">
            <span className="min-w-0">
              <span className="block text-apex-text-bright text-[17px]">{l.name}</span>
              <span className="block font-mono text-[13px] text-apex-muted uppercase">{[l.competitionName, l.ageGroupLabel].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="font-mono text-apex-text-bright whitespace-nowrap" data-testid="checkout-line-price">{formatPln(l.priceGrosze)}</span>
          </div>
        ))}
      </div>
      <div data-testid="checkout-amounts">
        <div className={row}><span>Opłaty startowe</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{m.entryLabel}</span></div>
        {m.askSupport && <SupportChoice options={m.options} onChoose={onChoice} disabled={busy} />}
        {m.askSupport && choice === true && (
          <div className={row}><span>Wsparcie LESZY.RUN</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{m.supportLabel}</span></div>
        )}
        <div className={row}><span>Obsługa płatności dpay · 0,9%</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{m.paymentFeeLabel}</span></div>
        <div className="flex justify-between gap-2.5 py-2 text-xl font-bold text-apex-text-bright" data-testid="checkout-total">
          <span>Razem</span><span className="font-mono text-apex-yellow whitespace-nowrap">{m.totalLabel}</span>
        </div>
      </div>
      {!open && <p className="text-apex-red text-base">Zapisy są zamknięte.</p>}
      {open && !payable && <p className="text-apex-red text-base" data-testid="paying-closed">{PAYING_CLOSED_TEXT}</p>}
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
