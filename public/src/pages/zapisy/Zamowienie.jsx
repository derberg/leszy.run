import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Navbar from '../../components/Navbar.jsx'
import useSeo from '../../hooks/useSeo.js'
import usePublicRegistrationEvent from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction } from '../../lib/auth.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { pollDelayMs } from '../../lib/orderPolling.js'
import { payLinkOpen } from '../../lib/checkout.js'
import PageTop from '../../components/registration/PageTop.jsx'
import DoneActions from '../../components/registration/DoneActions.jsx'
import RegisteredPerson from '../../components/registration/RegisteredPerson.jsx'
import { orderPeople, personGroupLabel, showsConsentTags } from '../../lib/consentTag.js'
import { labelCls, linkCls, primaryBtn, secondaryBtn } from '../../components/registration/ui.js'
import { formatPln } from '@registration/money.js'
import { eventPath } from './RegistrationEventPage.jsx'

// RA5 for a paid order, at /zamowienie/:orderId: where dpay sends the runner
// back (paid or not), and where the reminder e-mail points. The state is the
// server's (order-status, the buyer's session only), never the redirect's:
// order-status asks dpay itself when the IPN has not arrived yet. It is read a
// few times quickly after the page opens, then backing off (orderPolling.js:
// order-status allows 120 reads per order and hour), and not while the tab is
// hidden. The order id in the address is opaque and needs the buyer's session,
// so analytics may see it (trackedPath). No bib anywhere (spec §2).
//
// paid      → „OPŁACONE · <razem>”, „Jesteście na liście”, the people, „Co dalej”; in a
//             group each person's regulamin tag („✓ REGULAMIN” / „✓ OPIEKUN” /
//             „CZEKA NA ZGODĘ”) and „Wyślij przypomnienie do <imię> →” for an added
//             adult who has not accepted (the consent e-mail goes out on payment, so
//             a pending order shows no tags)
// pending   → „Opłać do <data, godzina>” and „Zapłać” (pay-order: a new dpay
//             transaction at the frozen price), none from the server's closesAt
//             on (order-status returns it; the page re-checks at that moment), and
//             „Brak wolnych miejsc” instead when the paid entries fill it (full, P3-R15);
//             „Anuluj zgłoszenie” (cancel-my-order, after a confirm step in the page)
//             always, and as the main action once full: until it is cancelled or
//             expires, the address cannot register again (409 pending_order)
// expired / cancelled → „Zgłoszenie wygasło” / „…anulowane” and „Zapisz się ponownie”

const warsaw = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

/** order-status for one order, re-read on the orderPolling schedule while it is pending. */
function useOrderStatus(orderId) {
  const [state, setState] = useState({ status: 'loading', order: null, polling: true })
  const timer = useRef(null)
  const reads = useRef(0)
  const alive = useRef(true)
  // Each chain of reads has a number; a read from an older chain arms nothing, so
  // „Sprawdź ponownie” during a read never leaves two chains polling.
  const chain = useRef(0)

  const read = useCallback(async (gen = chain.current) => {
    clearTimeout(timer.current)
    if (!alive.current || gen !== chain.current) return
    let next = null
    const current = () => alive.current && gen === chain.current
    try {
      const r = await callFunction('order-status', { orderId })
      if (!current()) return
      setState({ status: 'ok', order: r.data, polling: r.data.status === 'pending' })
      if (r.data.status === 'pending') next = pollDelayMs(++reads.current)
    } catch (err) {
      if (!current()) return
      if (err.status === 401) { setState({ status: 'anon', order: null, polling: false }); return }
      if (err.status === 404) { setState({ status: 'missing', order: null, polling: false }); return }
      next = pollDelayMs(++reads.current, { retryAfterSec: err.retryAfterSec })
      setState((s) => (s.order ? { ...s, polling: next != null } : { status: 'error', order: null, polling: false }))
    }
    if (!current()) return
    if (next == null) {
      setState((s) => ({ ...s, polling: false }))
      return
    }
    timer.current = setTimeout(function tick() {
      // A hidden tab reads nothing: the next read waits until it is shown again.
      if (document.hidden) {
        const shown = () => { document.removeEventListener('visibilitychange', shown); read(gen) }
        document.addEventListener('visibilitychange', shown)
        return
      }
      read(gen)
    }, next)
  }, [orderId])

  useEffect(() => {
    alive.current = true
    reads.current = 0
    read()
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [read])

  const again = useCallback(() => {
    chain.current += 1
    reads.current = 0
    setState((s) => ({ ...s, polling: true }))
    read(chain.current)
  }, [read])

  return { ...state, again }
}

function Person({ line, showTag = false, onStale }) {
  return (
    <RegisteredPerson person={line} registrationId={line.registrationId} name={line.name} showTag={showTag}
      onStale={onStale} testId="order-person"
      meta={[line.competition, personGroupLabel(line), line.startTime ? `start ${line.startTime}` : null]} />
  )
}

function Amounts({ amounts }) {
  const row = 'flex justify-between gap-2.5 py-1.5 border-b border-apex-border text-base'
  return (
    <div data-testid="order-amounts">
      <div className={row}><span>Opłaty startowe</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{formatPln(amounts.entryTotal)}</span></div>
      {amounts.supportFee > 0 && (
        <div className={row}><span>Wsparcie LESZY.RUN</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{formatPln(amounts.supportFee)}</span></div>
      )}
      <div className={row}><span>Obsługa płatności dpay</span><span className="font-mono text-apex-text-bright whitespace-nowrap">{formatPln(amounts.paymentFee)}</span></div>
      <div className="flex justify-between gap-2.5 py-1.5 text-lg font-bold text-apex-text-bright">
        <span>Razem</span><span className="font-mono text-apex-yellow whitespace-nowrap">{formatPln(amounts.total)}</span>
      </div>
    </div>
  )
}

function Paid({ order, raw, model, onAgain }) {
  const title = model?.title ?? order.event.name
  const day = model?.dateLabel?.split(' · ')[0]
  const people = orderPeople(order.lines)
  const first = people[0]
  const tags = showsConsentTags(people)
  return (
    <div className="flex flex-col gap-4" data-testid="order-paid">
      <PageTop right="KROK 3/3" />
      <div className="bg-apex-yellow text-apex-ink p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase" data-testid="order-paid-label">
          {order.amounts.total > 0 ? `Opłacone · ${formatPln(order.amounts.total)}` : 'Zapis potwierdzony'}
        </span>
        <span className="font-display font-extrabold text-4xl leading-none uppercase">Jesteście na liście</span>
        <span className="text-base font-semibold">{[title, day].filter(Boolean).join(' · ')}</span>
      </div>
      {people.map((l, i) => <Person key={l.registrationId ?? `${l.name}-${i}`} line={l} showTag={tags} onStale={onAgain} />)}
      {raw && first && (
        <DoneActions model={model} raw={raw} eventHref={eventPath(raw.slug)}
          first={{ uid: `${order.event.slug}-${first.name}`, name: first.name, competition: first.competition, startTime: first.startTime }} />
      )}
    </div>
  )
}

/**
 * „Anuluj zgłoszenie” with its confirm step in the page (never window.confirm). The order holds
 * no money, so nothing is refunded; a payment still on its way is refunded in full by the server.
 */
function CancelOrder({ orderId, prominent, onDone }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await callFunction('cancel-my-order', { orderId })
      onDone()
    } catch (err) {
      setBusy(false)
      setError(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
      if (err.status === 409) onDone()
    }
  }

  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className={prominent ? primaryBtn : secondaryBtn}
        data-testid="order-cancel" data-variant={prominent ? 'primary' : 'secondary'}>
        Anuluj zgłoszenie
      </button>
    )
  }
  return (
    <div className="border border-apex-red p-[18px] flex flex-col gap-3" data-testid="order-cancel-confirm" role="group" aria-labelledby="order-cancel-q">
      <span id="order-cancel-q" className="font-display font-extrabold text-2xl leading-none uppercase text-apex-text-bright">Na pewno anulować zgłoszenie?</span>
      <p className="text-base">
        Zgłoszenie zniknie z listy, a Ty możesz od razu zapisać się ponownie. Nie pobraliśmy żadnej opłaty; jeśli wpłata jest właśnie w drodze, zwrócimy ją w całości.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <button type="button" onClick={cancel} disabled={busy} className={primaryBtn}>{busy ? 'Chwileczkę…' : 'Tak, anuluj'}</button>
        <button type="button" onClick={() => { setAsking(false); setError(null) }} disabled={busy} className={secondaryBtn}>Nie, zostaw</button>
      </div>
      {error && <p className="text-apex-red text-base" role="alert">{error}</p>}
    </div>
  )
}

function Pending({ orderId, order, raw, polling, onAgain }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [, tick] = useState(0)
  const closesAt = order.closesAt ?? raw?.closesAt ?? null
  const closed = !payLinkOpen(closesAt)

  // A page left open across closes_at drops „Zapłać” at that moment.
  useEffect(() => {
    const until = Date.parse(closesAt ?? '') - Date.now()
    if (!(until > 0) || until > 2 ** 31 - 1) return undefined
    const t = setTimeout(() => tick((n) => n + 1), until + 50)
    return () => clearTimeout(t)
  }, [closesAt])

  // Back from dpay into a page kept in the back/forward cache: not stuck at „Chwileczkę…”,
  // and the status read again.
  useEffect(() => {
    const onShow = (e) => {
      if (!e.persisted) return
      setBusy(false)
      onAgain()
    }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [onAgain])

  async function pay() {
    setBusy(true)
    setMessage(null)
    try {
      const r = await callFunction('pay-order', { orderId })
      window.location.assign(r.data.redirectUrl)
    } catch (err) {
      setBusy(false)
      setMessage(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
      if (err.status === 409) onAgain()
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="order-pending">
      <PageTop back={raw ? { to: eventPath(raw.slug), label: 'Zawody' } : null} right={order.event.name} />
      <div className="border border-apex-cyan p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase text-apex-cyan">Czeka na wpłatę · {formatPln(order.amounts.total)}</span>
        <span className="font-display font-extrabold text-[32px] leading-none uppercase text-apex-text-bright">Zgłoszenie czeka na wpłatę</span>
        {order.expiresAt && (
          <span className="text-base font-semibold text-apex-text-bright" data-testid="order-deadline">Opłać do {warsaw.format(new Date(order.expiresAt))}</span>
        )}
      </div>
      {orderPeople(order.lines).map((l, i) => <Person key={l.registrationId ?? `${l.name}-${i}`} line={l} />)}
      <Amounts amounts={order.amounts} />
      {closed
        ? <p className="text-apex-red text-base" data-testid="order-closed">Zapisy są zamknięte.</p>
        : order.full
          ? (
            <div className="flex flex-col gap-3">
              <p className="text-apex-red text-base" data-testid="order-full">Brak wolnych miejsc. Inne osoby opłaciły już wszystkie miejsca w tej konkurencji.</p>
              <p className="text-base" data-testid="order-full-cancel-hint">Tego zgłoszenia nie można już opłacić. Anuluj je, żeby zapisać się ponownie, np. na inną konkurencję.</p>
              <CancelOrder orderId={orderId} prominent onDone={onAgain} />
            </div>
            )
          : (
          <button type="button" onClick={pay} disabled={busy} className={primaryBtn} data-testid="order-pay">
            {busy ? 'Chwileczkę…' : 'Zapłać'}
          </button>
          )}
      {message && <p className="text-apex-red text-base" role="alert">{message}</p>}
      {polling
        ? <span className="font-mono text-xs uppercase text-apex-muted" data-testid="order-checking" aria-live="polite">Sprawdzamy płatność…</span>
        : (
          <button type="button" onClick={onAgain} className={secondaryBtn} data-testid="order-recheck">Sprawdź ponownie</button>
        )}
      <p className="text-sm text-apex-muted">
        Miejsce jest Twoje dopiero po wpłacie: limit liczy tylko opłacone zgłoszenia. Jeśli wpłata nie dotrze do tego terminu, zgłoszenie wygaśnie.
      </p>
      {!order.full && <CancelOrder orderId={orderId} onDone={onAgain} />}
    </div>
  )
}

// A cancelled order whose payment arrived but could not be accepted: the money goes back
// in full (confirm_order's late_refund, P3-R15), and the refund e-mail says the same.
const ENDED_REASONS = {
  full: 'Zanim Twoja wpłata dotarła, inne osoby opłaciły ostatnie wolne miejsca. Zwracamy całą wpłatę.',
  unavailable: 'Zapisy na tę konkurencję nie są już prowadzone. Zwracamy całą wpłatę.',
  closed: 'Wpłata dotarła po zamknięciu zapisów. Zwracamy całą wpłatę.',
  buyer_cancelled: 'Anulowano zgłoszenie na Twoją prośbę. Możesz zapisać się jeszcze raz.',
}

function Ended({ order, raw }) {
  const expired = order.status === 'expired'
  const href = raw ? eventPath(raw.slug) : order.event.slug ? eventPath(order.event.slug) : '/'
  return (
    <div className="flex flex-col gap-4" data-testid="order-ended">
      <PageTop right={order.event.name} />
      <div className="border border-apex-border-bright p-[18px] flex flex-col gap-1">
        <span className={labelCls}>{expired ? 'Brak wpłaty w terminie' : 'Zgłoszenie anulowane'}</span>
        <span className="font-display font-extrabold text-[32px] leading-none uppercase text-apex-text-bright">
          {expired ? 'Zgłoszenie wygasło' : 'Zgłoszenie anulowane'}
        </span>
      </div>
      <p className="text-lg">
        {expired
          ? 'Nie dostaliśmy wpłaty w terminie. Możesz zapisać się jeszcze raz, po aktualnej cenie.'
          : ENDED_REASONS[order.cancelledReason] ?? 'To zgłoszenie nie jest już ważne. Możesz zapisać się jeszcze raz.'}
      </p>
      <Link to={href} className={`${primaryBtn} flex items-center justify-center`} data-testid="order-again">Zapisz się ponownie</Link>
    </div>
  )
}

function Message({ children, action }) {
  return (
    <div className="flex flex-col gap-4" data-testid="order-message">
      <PageTop right="Zgłoszenie" />
      <p className="text-lg text-apex-text-bright">{children}</p>
      {action}
    </div>
  )
}

export default function Zamowienie() {
  const { orderId } = useParams()
  const order = useOrderStatus(orderId)
  const event = usePublicRegistrationEvent(order.order?.event?.slug ?? null)
  const raw = event.status === 'ok' ? event.raw : null
  const model = raw ? eventPageModel(raw) : null
  useSeo({ title: 'Zgłoszenie', path: `/zamowienie/${orderId}`, noindex: true })

  let body
  if (order.status === 'loading') {
    body = (
      <div className="flex flex-col gap-4" aria-busy="true" data-testid="order-loading">
        <span className="font-mono text-xs uppercase text-apex-muted">Sprawdzamy płatność…</span>
        <div className="h-28 bg-apex-surface" /><div className="h-16 bg-apex-surface" />
      </div>
    )
  } else if (order.status === 'anon') {
    body = (
      <Message action={<Link to={`/login?from=${encodeURIComponent(`/zamowienie/${orderId}`)}`} className={linkCls}>Zaloguj się</Link>}>
        Zaloguj się adresem, na który przyszło potwierdzenie, żeby zobaczyć zgłoszenie.
      </Message>
    )
  } else if (order.status === 'missing') {
    body = <Message>Nie znaleźliśmy tego zgłoszenia na Twoim koncie.</Message>
  } else if (order.status === 'error') {
    body = <Message>Nie udało się wczytać zgłoszenia. Odśwież stronę.</Message>
  } else if (order.order.status === 'paid') {
    body = <Paid order={order.order} raw={raw} model={model} onAgain={order.again} />
  } else if (order.order.status === 'pending') {
    body = <Pending orderId={orderId} order={order.order} raw={raw} polling={order.polling} onAgain={order.again} />
  } else {
    body = <Ended order={order.order} raw={raw} />
  }

  return (
    <>
      <Navbar />
      <main id="main-content" className="bg-apex-bg text-apex-text font-sans min-h-[70vh]">
        <div className="max-w-2xl mx-auto px-4 sm:px-5 pt-[70px] pb-12 flex flex-col gap-4">{body}</div>
      </main>
    </>
  )
}
