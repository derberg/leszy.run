import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import { callFunction } from '../../lib/auth.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { MONEY_NOTE, inviteError, untilLabel } from '../../lib/transferCopy.js'
import PageTop from '../../components/registration/PageTop.jsx'
import MetaLine from '../../components/registration/MetaLine.jsx'
import { inputCls, labelCls, linkCls, primaryBtn, secondaryBtn } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'

// RA6 at /events/:slug/przekaz/:registrationId (Plan 7): the holder hands their package to somebody
// else. The entry and its transfer block come from my-event-registrations (the session's own rows,
// never the address bar): the page offers anything only where `transfer.allowed` says so (its own
// adult entry or a team's as captain, transfers on, today ≤ the organizer's last day; ruling 3).
// Money between the two people is settled outside LESZY.RUN, said at the top. There is no fee.
//
// transfer-invite: create { registrationId, toEmail } sends the invite (the link's token never
// reaches this page), cancel { transferId } takes it back. Every refusal reads in Polish
// (transferCopy.js) under the one field it belongs to.

const FIELD = 'transfer-email'

function useEntry(slug, registrationId) {
  const [state, setState] = useState({ status: 'loading', row: null })
  const reads = useRef(0)
  const read = useCallback(async () => {
    const n = ++reads.current
    try {
      const r = await callFunction('my-event-registrations', { slug })
      if (n !== reads.current) return
      const row = (r.data ?? []).find((x) => x.id === registrationId) ?? null
      setState({ status: row ? 'ok' : 'missing', row })
    } catch (err) {
      if (n !== reads.current) return
      setState((s) => (s.status === 'ok' ? s : { status: err.status === 401 ? 'anon' : 'error', row: null }))
    }
  }, [slug, registrationId])
  useEffect(() => { read() }, [read])
  return { ...state, read, setState }
}

function Unavailable({ message, slug }) {
  return (
    <div className="flex flex-col gap-4" data-testid="transfer-unavailable">
      <p className="text-lg text-apex-text-bright">{message}</p>
      <Link to={`${eventPath(slug)}/zapisano`} className={linkCls}>Twój zapis</Link>
    </div>
  )
}

/** Why a row the session sees is not offered (ruling 3): a child's or a member's entry, or the date. */
function refusalOf(row) {
  if (row.role === 'minor' || (row.teamId && !row.isCaptain) || row.mine !== true) return 'Tego pakietu nie można przekazać.'
  return 'Przekazanie pakietu nie jest już możliwe.'
}

function InviteForm({ row, onSent }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction('transfer-invite', { action: 'create', registrationId: row.id, toEmail: email.trim() })
      onSent(r.data)
    } catch (err) {
      setBusy(false)
      setError(inviteError(err))
      // Somebody (another tab) invited meanwhile: show what is open now.
      if (err.code === 'pending_exists' || err.code === 'transfer_off' || err.status === 404) onSent(null)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" data-testid="transfer-form">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={FIELD} className={labelCls}>E-mail osoby, która przejmie pakiet</label>
        <input id={FIELD} type="email" autoComplete="off" maxLength={254} required value={email} disabled={busy}
          onChange={(e) => { setEmail(e.target.value); setError(null) }}
          aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${FIELD}-error` : undefined}
          className={`${inputCls} ${error ? 'border-apex-red' : ''}`} />
        {error && <p id={`${FIELD}-error`} className="text-apex-red text-sm" role="alert" data-testid="transfer-email-error">{error}</p>}
      </div>
      <button type="submit" disabled={busy || !email.trim()} className={primaryBtn}>{busy ? 'Wysyłamy…' : 'Wyślij zaproszenie'}</button>
    </form>
  )
}

function Pending({ pending, notEmailed, onCancelled }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await callFunction('transfer-invite', { action: 'cancel', transferId: pending.transferId })
      onCancelled()
    } catch (err) {
      setBusy(false)
      setError(inviteError(err))
      // Accepted, cancelled or lapsed meanwhile: read the entry again.
      if (err.status === 409 || err.status === 404) onCancelled()
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="transfer-pending">
      <div className="border border-apex-cyan p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase text-apex-cyan-text">Zaproszenie wysłane</span>
        <span className="text-lg font-bold text-apex-text-bright [overflow-wrap:anywhere]">Czeka na {pending.toEmail}</span>
      </div>
      {notEmailed && (
        <p className="text-apex-red text-base" role="alert" data-testid="transfer-not-emailed">
          Nie udało się wysłać e-maila z zaproszeniem. Cofnij zaproszenie i wyślij je ponownie.
        </p>
      )}
      <button type="button" onClick={cancel} disabled={busy} className={secondaryBtn}>{busy ? 'Chwileczkę…' : 'Cofnij zaproszenie'}</button>
      {error && <p className="text-apex-red text-base" role="alert" data-testid="transfer-cancel-error">{error}</p>}
    </div>
  )
}

function Handover({ raw, registrationId }) {
  const model = eventPageModel(raw)
  const entry = useEntry(raw.slug, registrationId)
  const [notEmailed, setNotEmailed] = useState(false)
  const back = { to: `${eventPath(raw.slug)}/zapisano`, label: 'Twój zapis' }
  const top = <PageTop back={back} right={model.title} />

  if (entry.status === 'loading') {
    return <div className="flex flex-col gap-4" aria-busy="true"><div className="h-11 bg-apex-surface" /><div className="h-28 bg-apex-surface" /><div className="h-24 bg-apex-surface" /></div>
  }
  if (entry.status === 'anon') {
    const from = `${eventPath(raw.slug)}/przekaz/${registrationId}`
    return (
      <div className="flex flex-col gap-4" data-testid="transfer-anon">
        {top}
        <p className="text-lg text-apex-text-bright">Zaloguj się, żeby przekazać pakiet.</p>
        <Link to={`/login?from=${encodeURIComponent(from)}`} className={linkCls}>Zaloguj się</Link>
      </div>
    )
  }
  if (entry.status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        {top}
        <p className="text-apex-red text-lg" role="alert">Nie udało się wczytać zapisu. Odśwież stronę.</p>
        <button type="button" onClick={entry.read} className={secondaryBtn}>Spróbuj ponownie</button>
      </div>
    )
  }
  if (entry.status === 'missing') return <>{top}<Unavailable slug={raw.slug} message="Nie znaleźliśmy tego zgłoszenia." /></>
  const { row } = entry
  if (row.transfer?.allowed !== true) return <>{top}<Unavailable slug={raw.slug} message={refusalOf(row)} /></>

  const pending = row.transfer.pending
  const until = untilLabel(row.transfer.until)
  return (
    <div className="flex flex-col gap-4" data-testid="transfer-invite">
      {top}
      <p className="text-base text-apex-text-bright border-l-2 border-apex-yellow pl-3" data-testid="transfer-money">{MONEY_NOTE}</p>
      <h1 className="font-display font-extrabold text-[38px] leading-none uppercase text-apex-text-bright">Przekaż pakiet</h1>
      <div className="border border-apex-border-mid bg-apex-surface p-3.5 flex flex-col gap-1.5">
        <span className="block text-lg font-bold text-apex-text-bright [overflow-wrap:anywhere]">{row.firstName} {row.lastName}</span>
        <MetaLine parts={[row.competition, row.startTime ? `start ${row.startTime}` : null]} />
        {until && (
          <span className="self-start border border-apex-yellow-dim px-1.5 py-0.5 font-mono text-xs uppercase text-apex-yellow whitespace-nowrap" data-testid="transfer-until">
            {until}
          </span>
        )}
      </div>
      {pending
        ? <Pending pending={pending} notEmailed={notEmailed} onCancelled={() => { setNotEmailed(false); entry.read() }} />
        : <InviteForm row={row} onSent={(data) => {
            if (data) {
              setNotEmailed(data.emailed === false)
              entry.setState({ status: 'ok', row: { ...row, transfer: { ...row.transfer, pending: { transferId: data.transferId, toEmail: data.toEmail, expiresAt: data.expiresAt } } } })
            }
            entry.read()
          }} />}
    </div>
  )
}

function Seo({ raw, registrationId }) {
  useSeo({ title: `Przekaż pakiet — ${raw.name}`, path: `${eventPath(raw.slug)}/przekaz/${registrationId}`, noindex: true })
  return null
}

export default function Przekaz() {
  const { slug, registrationId } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} registrationId={registrationId} /><Handover raw={raw} registrationId={registrationId} /></>}
    </RegistrationShell>
  )
}
