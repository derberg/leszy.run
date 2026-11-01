import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import useAuth from '../../hooks/useAuth.js'
import useSeo from '../../hooks/useSeo.js'
import { callFunction } from '../../lib/auth.js'
import { reloadPublicRegistrationEvent } from '../../hooks/usePublicRegistrationEvent.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { canRemind } from '../../lib/consentTag.js'
import { cardVariant } from '../../lib/groupDraft.js'
import { useLeaveGuard } from '../../lib/leaveGuard.js'
import { useMoveFocus } from '../../lib/useMoveFocus.jsx'
import { useStepHistory } from '../../lib/useStepHistory.js'
import { consentsComplete, fieldModes } from '../../lib/personFormModel.js'
import { ADULT_EMAIL_NOTE, teamContext } from '../../lib/teamDraft.js'
import {
  addLabel, checkMember, lastChangeDay, memberMeta, memberName, moveLeg, newMember, squadFailure, teamPath, teamStatusLabel, toMemberRequest,
} from '../../lib/teamPage.js'
import { warsawToday } from '@registration/dates.js'
import { runnerDataInfo } from '../../legal/runnerDataInfo.js'
import ConsentList from '../../components/registration/ConsentList.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import PersonForm from '../../components/registration/PersonForm.jsx'
import { MoveButtons, RemoveConfirm } from '../../components/registration/PersonRow.jsx'
import RegisteredPerson from '../../components/registration/RegisteredPerson.jsx'
import { editBtn, primaryBtn, secondaryBtn, sectionCls } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath } from './RegistrationEventPage.jsx'
import { orderPath } from './Podsumowanie.jsx'

// RB4, the captain's page for one team, reached from the team's e-mails. Everything comes from
// team-squad, whose edits answer the same `data` as its read; the competition's rules and the
// consents come from the public snapshot. A step at a time, in browser history like the forms:
// 'view' the squad and its actions, 'order' ↑/↓, 'pick' who is swapped, 'member' one person's form
// (a swap or an add). A child's form carries the guardian's box and the event's consents: an adult
// accepts from the e-mail, a child's acceptances are the captain's. A swap asks „Usunąć tę osobę?”
// in place only when it is about to happen, because it is what writes somebody off the team.
// No session goes to login and back (D5-7). After closes_at the squad actions give way to one line;
// the consent reminders stay, because an adult can still accept after close. A reminder sent is held
// here and survives the steps, since sending another would kill the link just sent.

const CLOSED = 'Zapisy są zamknięte — skład zmienisz w biurze zawodów.'

function Team({ raw: shellRaw, teamId, notice, setNotice }) {
  const navigate = useNavigate()
  // The snapshot read again after the server said the consents moved on.
  const [freshRaw, setFreshRaw] = useState(null)
  const raw = freshRaw ?? shellRaw
  const { user } = useAuth()
  const model = useMemo(() => eventPageModel(raw), [raw])
  const [state, setState] = useState({ status: 'loading', data: null })
  const [step, setStep] = useState('view')
  // The squad being reordered (registration ids), and the form: { kind, target, person, guardianConsent }.
  const [order, setOrder] = useState(null)
  const [form, setForm] = useState(null)
  const [errors, setErrors] = useState({})
  const [message, setMessage] = useState(null)
  const [reminded, setReminded] = useState(() => new Set())
  const [confirming, setConfirming] = useState(false)
  const [refusedClosed, setRefusedClosed] = useState(false)
  const [accepted, setAccepted] = useState({})
  const [serviceAccepted, setServiceAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  // The member fields are disabled while busy, so a server error can only be
  // focused once the form is enabled again: a rAF ran before that commit.
  const [focusError, setFocusError] = useState(0)
  useEffect(() => {
    if (focusError && !busy) document.querySelector('[aria-invalid="true"]')?.focus()
  }, [focusError, busy])
  const inFlight = useRef(false)
  const moves = useMoveFocus()
  const path = teamPath(raw.slug, teamId)

  const toLogin = useCallback(() => navigate(`/login?from=${encodeURIComponent(path)}`, { replace: true }), [navigate, path])

  const read = useCallback(async () => {
    try {
      const r = await callFunction('team-squad', { teamId, action: 'get' })
      // The address names the event, and the consents and rules on this page are that event's.
      if (r.data.event.slug !== raw.slug) setState({ status: 'missing', data: null })
      else setState({ status: 'ok', data: r.data })
    } catch (err) {
      if (err.status === 401) toLogin()
      else if (err.status === 404) setState({ status: 'missing', data: null })
      else setState((s) => (s.data ? s : { status: 'error', data: null }))
    }
  }, [teamId, raw.slug, toLogin])

  useEffect(() => { read() }, [read])

  const data = state.data
  const today = warsawToday()
  const editing = step === 'member' && !!form
  useLeaveGuard(editing && Object.values(form.person).some(Boolean))

  useStepHistory({
    id: step,
    state: { step },
    guard: false,
    onEnter: () => {
      window.scrollTo({ top: 0, behavior: 'instant' })
      document.getElementById(step === 'member' ? 'm-first' : `team-${step}`)?.focus({ preventScroll: true })
    },
    onRestore: (s) => {
      setMessage(null)
      setConfirming(false)
      setStep(s.step)
    },
  })

  if (state.status === 'loading') {
    return <div className="flex flex-col gap-4" aria-busy="true"><div className="h-28 bg-apex-surface" /><div className="h-16 bg-apex-surface" /></div>
  }
  if (state.status !== 'ok') {
    return (
      <div className="flex flex-col gap-4" data-testid="team-missing">
        <PageTop back={{ to: eventPath(raw.slug), label: 'Zawody' }} right={model.title} />
        <p className="text-lg text-apex-text-bright">
          {state.status === 'missing' ? 'Nie znaleźliśmy tej drużyny.' : 'Nie udało się wczytać drużyny. Odśwież stronę.'}
        </p>
      </div>
    )
  }

  const { team, members, competition: comp } = data
  const legOrder = team.legOrderEnabled
  const closed = refusedClosed || !team.editsOpen
  const competition = raw.competitions.find((c) => c.categoryId === comp.categoryId) ?? null
  const context = competition ? teamContext(raw, competition) : null
  const fields = fieldModes(raw.formFields)
  const consents = raw.consents ?? []
  const add = competition ? addLabel({ count: members.length, max: team.teamMax }) : null
  const statusLabel = teamStatusLabel(team.paymentStatus)
  const day = model.dateLabel?.split(' · ')[0]
  const lastDay = lastChangeDay(team.closesAt)

  // Only a confirmed team has asked anybody yet: a pending team's adults are asked when the fee lands.
  const reminders = team.status === 'confirmed'

  function back() {
    setMessage(null)
    setConfirming(false)
    setStep('view')
  }

  function openOrder() {
    setNotice(null)
    setMessage(null)
    setOrder(members.map((m) => m.registrationId))
    setStep('order')
  }

  function openForm(kind, target = null) {
    setNotice(null)
    setMessage(null)
    setErrors({})
    setConfirming(false)
    setAccepted({})
    setServiceAccepted(false)
    setForm({ kind, target, ...newMember() })
    setStep('member')
  }

  async function edit(action, body) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage(null)
    try {
      const r = await callFunction('team-squad', { teamId, action, ...body })
      setState({ status: 'ok', data: r.data })
      setForm(null)
      setOrder(null)
      setConfirming(false)
      setNotice('Skład zmieniony.')
      setStep('view')
    } catch (err) {
      const f = squadFailure(err)
      setConfirming(false)
      if (f.login) toLogin()
      else if (f.missing) setState({ status: 'missing', data: null })
      else if (f.closed || f.stale) {
        setRefusedClosed(f.closed)
        setNotice(null)
        setMessage(f.message)
        setForm(null)
        setOrder(null)
        setStep('view')
        await read()
      } else if (f.consentsChanged) {
        setMessage(f.message)
        setAccepted({})
        setServiceAccepted(false)
        const next = await reloadPublicRegistrationEvent(raw.slug)
        if (next.status === 'ok') setFreshRaw(next.raw)
      } else {
        setErrors(f.fields)
        setMessage(f.message ?? (Object.keys(f.fields).length ? 'Popraw zaznaczone pola.' : null))
        setFocusError((n) => n + 1)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function submitMember(e) {
    e.preventDefault()
    const found = checkMember(form, { context, today })
    if (Object.keys(found).length) {
      setErrors(found)
      setMessage('Popraw zaznaczone pola.')
      setFocusError((n) => n + 1)
      return undefined
    }
    if (form.kind === 'swap' && !confirming) { setConfirming(true); return undefined }
    return saveMember()
  }

  function saveMember() {
    const body = toMemberRequest(form, { consents, today })
    return edit(form.kind, form.kind === 'swap' ? { registrationId: form.target.registrationId, ...body } : body)
  }

  const errorLine = message && <p className="text-apex-red text-base" role="alert" data-testid="form-error">{message}</p>
  const top = (label) => <PageTop back={{ label, onClick: back }} right={team.name} />

  if (step === 'order' && order && !closed) {
    const byId = new Map(members.map((m) => [m.registrationId, m]))
    return (
      <div className="flex flex-col gap-[18px]" data-testid="squad-order">
        {top('Drużyna')}
        <h1 id="team-order" tabIndex={-1} className={`${sectionCls} outline-none`}>Zmień kolejność zmian</h1>
        <ul className="flex flex-col gap-2">
          {order.map((id, i) => {
            const name = memberName(byId.get(id))
            return (
              <li key={id} className="border border-apex-border-mid bg-apex-surface px-3.5 py-2.5 flex items-center gap-3">
                <MoveButtons moveKey={id} name={name} place={i + 1} count={order.length} disabled={busy} onMove={(dir) => {
                  setOrder((o) => moveLeg(o, i, dir))
                  moves.moved(id, dir, `${name}: zmiana ${i + 1 + dir}`)
                }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs text-apex-muted uppercase">Zmiana {i + 1}</span>
                  <span className="block text-[17px] text-apex-text-bright [overflow-wrap:anywhere]">{name}</span>
                </span>
              </li>
            )
          })}
        </ul>
        {moves.status}
        {errorLine}
        <button type="button" onClick={() => edit('reorder', { legs: order })} disabled={busy} className={primaryBtn}>
          {busy ? 'Chwileczkę…' : 'Zapisz kolejność'}
        </button>
      </div>
    )
  }

  if (step === 'pick' && !closed) {
    return (
      <div className="flex flex-col gap-[18px]" data-testid="squad-pick">
        {top('Drużyna')}
        <h1 id="team-pick" tabIndex={-1} className={`${sectionCls} outline-none`}>Kogo wymieniasz?</h1>
        <ul className="flex flex-col gap-2">
          {members.filter((m) => !m.isCaptain).map((m) => (
            <li key={m.registrationId} className="border border-apex-border-mid bg-apex-surface px-3.5 py-2.5 flex items-center justify-between gap-3">
              <span className="min-w-0 text-[17px] text-apex-text-bright [overflow-wrap:anywhere]">{memberName(m)}</span>
              <button type="button" onClick={() => openForm('swap', m)} className={editBtn} aria-label={`Wymień — ${memberName(m)}`}>Wymień</button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (editing && !closed && context) {
    const variant = cardVariant(form.person, today)
    const minor = variant === 'minor'
    const ready = !minor || consentsComplete(consents, accepted, serviceAccepted)
    const label = form.kind === 'swap' ? 'Wymień zawodnika' : add
    const dataInfo = runnerDataInfo({
      eventName: model.title, organizerName: model.organizerName, contactEmail: model.contactEmail,
      paid: raw.pricingMode !== 'free', teams: true, nationality: fields.nationality !== 'off',
    })
    const change = (patch) => {
      setForm((f) => ({ ...f, person: { ...f.person, ...patch } }))
      setConfirming(false)
      setErrors((e) => {
        const next = { ...e }
        for (const k of Object.keys(patch)) delete next[k]
        return next
      })
    }
    return (
      <form onSubmit={submitMember} noValidate className="flex flex-col gap-[18px]" data-testid="squad-member">
        {top(form.kind === 'swap' ? 'Kogo wymieniasz' : 'Drużyna')}
        <h1 className={sectionCls}>{form.kind === 'swap' ? `Nowa osoba za: ${memberName(form.target)}` : label}</h1>
        <PersonForm fields={fields} value={form.person} onChange={change} errors={errors} competition={competition}
          raceDate={context.raceDate} reckoning={context.reckoning} ageGroups={context.ageGroups} disabled={busy}
          variant={variant} idPrefix="m" prefill={null} codeNote={variant === 'adult' ? ADULT_EMAIL_NOTE : undefined}
          guardian={{
            name: memberName(members.find((m) => m.isCaptain) ?? {}), email: user?.email, checked: form.guardianConsent,
            onChange: (v) => {
              setForm((f) => ({ ...f, guardianConsent: v }))
              setErrors(({ guardianConsent: _gone, ...rest }) => rest)
            },
          }} />
        {minor && (
          <ConsentList consents={consents} accepted={accepted} onToggle={(id, v) => setAccepted((a) => ({ ...a, [id]: v }))}
            serviceAccepted={serviceAccepted} onService={setServiceAccepted} regulaminUrl={model.regulaminUrl} dataInfo={dataInfo} />
        )}
        {errorLine}
        {confirming
          ? <RemoveConfirm id="m-remove-q" name={memberName(form.target)} onYes={saveMember} onNo={() => setConfirming(false)} />
          : (
            <button type="submit" disabled={busy || !ready} className={primaryBtn}>
              {busy ? 'Chwileczkę…' : label}
            </button>
          )}
      </form>
    )
  }

  const canSwap = !!context && members.some((m) => !m.isCaptain)
  return (
    <div className="flex flex-col gap-4" data-testid="team-page">
      <PageTop back={{ to: eventPath(raw.slug), label: 'Zawody' }} right={model.title} />
      <div className="border border-apex-border-mid bg-apex-surface p-[18px] flex flex-col gap-1.5">
        <div className="flex justify-between items-center gap-3">
          <span className="font-mono text-xs uppercase text-apex-muted">Kapitan</span>
          {statusLabel && (
            <span className={`border px-1.5 py-0.5 font-mono text-xs uppercase whitespace-nowrap ${team.paymentStatus === 'awaiting'
              ? 'border-apex-cyan text-apex-cyan-text' : 'border-apex-yellow-dim text-apex-yellow'}`} data-testid="team-status">{statusLabel}</span>
          )}
        </div>
        <h1 id="team-view" tabIndex={-1} className="font-display font-extrabold text-4xl leading-none uppercase text-apex-text-bright [overflow-wrap:anywhere] outline-none">{team.name}</h1>
        <span className="text-base font-semibold text-apex-text">{[comp.name, day].filter(Boolean).join(' · ')}</span>
      </div>

      {team.status === 'pending_payment' && team.orderId && (
        <div className="flex flex-col gap-2">
          {team.payable && <Link to={orderPath(team.orderId)} data-action className={`${primaryBtn} flex items-center justify-center`}>Zapłać</Link>}
          <Link to={orderPath(team.orderId)} data-action className={secondaryBtn}>Anuluj zgłoszenie</Link>
        </div>
      )}

      <h2 className={sectionCls}>{legOrder ? 'Skład · kolejność zmian' : 'Skład'}</h2>
      {members.map((m) => (
        <RegisteredPerson key={m.registrationId} person={m} registrationId={reminders && canRemind(m) ? m.registrationId : undefined}
          name={memberName(m)} showTag testId="team-member" meta={memberMeta(m, legOrder)} onStale={read}
          reminded={reminded.has(m.registrationId)}
          onReminded={(id) => setReminded((ids) => new Set(ids).add(id))} />
      ))}

      {notice && <p className="text-base text-apex-text-bright" aria-hidden="true" data-testid="team-notice">{notice}</p>}
      {message && <p className="text-apex-red text-base" role="alert" data-testid="form-error">{message}</p>}

      {closed
        ? <p className="text-lg text-apex-text-bright" role="status" data-testid="team-closed">{CLOSED}</p>
        : (
          <div className="flex flex-col gap-2">
            {lastDay && <p className="font-mono text-xs tracking-wider uppercase text-apex-muted">Zmiany do {lastDay}</p>}
            {legOrder && <button type="button" onClick={openOrder} className={secondaryBtn}>Zmień kolejność zmian</button>}
            {canSwap && <button type="button" onClick={() => { setNotice(null); setStep('pick') }} className={secondaryBtn}>Wymień zawodnika</button>}
            {add && <button type="button" onClick={() => openForm('add')} className={secondaryBtn}>{add}</button>}
          </div>
        )}
    </div>
  )
}

/** The live region sits above Team's steps: one inserted already holding its text is not announced. */
function TeamWithStatus({ raw, teamId }) {
  const [notice, setNotice] = useState(null)
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" data-testid="team-live">{notice}</span>
      <Team raw={raw} teamId={teamId} notice={notice} setNotice={setNotice} />
    </>
  )
}

function Seo({ raw }) {
  useSeo({ title: `Drużyna — ${raw.name}`, path: eventPath(raw.slug), noindex: true })
  return null
}

export default function Druzyna() {
  const { slug, teamId } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} /><TeamWithStatus raw={raw} teamId={teamId} /></>}
    </RegistrationShell>
  )
}
