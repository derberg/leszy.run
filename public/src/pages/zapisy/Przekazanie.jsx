import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../../components/Navbar.jsx'
import useAuth, { clearAuthCache } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import useSeo from '../../hooks/useSeo.js'
import usePublicRegistrationEvent from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction } from '../../lib/auth.js'
import { dataInfoOf } from '../../lib/dataInfo.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { afterRegistrationPath } from '../../lib/inviteLink.js'
import {
  EMPTY_PERSON, checkPerson, consentsComplete, fieldModes, mergePrefill, needsCode, personContext, profilePrefill,
} from '../../lib/personFormModel.js'
import { forgetTransferToken, transferToken, TRANSFER_PATH } from '../../lib/transferToken.js'
import { DUE_LABEL, ENDS_LINK, GONE, OFFLINE, acceptError, closedBadge, samePriceLabel } from '../../lib/transferCopy.js'
import PersonForm from '../../components/registration/PersonForm.jsx'
import ConsentList from '../../components/registration/ConsentList.jsx'
import CodeStep from '../../components/registration/CodeStep.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import { inputCls, labelCls, primaryBtn, secondaryBtn } from '../../components/registration/ui.js'
import { eventPath } from './RegistrationEventPage.jsx'

// RA7 at /przekazanie#<token> (Plan 7): somebody hands the reader their package. main.jsx has taken
// the token out of the address bar before anything rendered (transferToken.js), so no request,
// referrer or analytics hit carries it. The link works for whoever holds it (§12.6): the reader
// types their own data, picks a competition at the same price (ruling 2), ticks every consent and
// proves the address with the e-mail code (none when the session is already on that address). They
// pay nothing („Do zapłaty: 0 zł.”); after closes_at the link still works.
//
// API: transfer-accept { token } (preview), { token, sendCode: true, email }, and { token, code?,
// person, categoryId, acceptedConsentIds, serviceRegulamin: true } (accept). A dead link answers 409
// gone, and every refusal reads in Polish (transferCopy.js). The per-token limit is 10 calls an hour,
// so the page reads once on load and otherwise only on the person's action.

const TITLE = 'Przekazanie pakietu'
const CATEGORY = 'transfer-category'
const ON_EMAIL = new Set(['duplicate', 'pending_elsewhere', 'email_retired', 'profile_mismatch', 'invalid_email'])
const ON_CATEGORY = new Set(['price_differs', 'unavailable', 'team_competition'])
// Refusals that come before the code is checked: the code was not used.
const BEFORE_CODE = new Set(['code_required', 'email_retired', 'throttled', 'gone', 'invalid_token', 'transfer_off', 'invalid_email'])

function Shell({ authKey = 0, children }) {
  return (
    <>
      <Navbar key={authKey} />
      <main id="main-content" className="bg-apex-bg text-apex-text font-sans min-h-[70vh]">
        <div className="max-w-2xl mx-auto px-4 sm:px-5 pt-[70px] pb-12 flex flex-col gap-4">{children}</div>
      </main>
    </>
  )
}

const dateLabel = (iso) => {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)))
}

const optionLabel = (c) => [c.name, c.startTime ? `start ${c.startTime}` : null].filter(Boolean).join(' · ')

function EventStrip({ event }) {
  return (
    <div className="border border-apex-yellow px-3.5 py-3 flex flex-col gap-0.5" data-testid="transfer-event">
      <span className="text-lg font-bold text-apex-text-bright [overflow-wrap:anywhere]">{event.name}</span>
      <span className="font-mono text-[13px] text-apex-muted uppercase">{[dateLabel(event.date), event.place].filter(Boolean).join(' · ')}</span>
    </div>
  )
}

function Gone({ message }) {
  return (
    <div className="flex flex-col gap-4" data-testid="transfer-gone">
      <PageTop right={TITLE} />
      <h1 className="font-display font-extrabold text-[34px] leading-none uppercase text-apex-text-bright">Link nieaktywny</h1>
      <p className="text-lg text-apex-text-bright">{message}</p>
      <Link to="/" className={secondaryBtn}>Strona główna</Link>
    </div>
  )
}

function Done({ done }) {
  const { user } = useAuth()
  const slug = done.event.slug
  return (
    <div className="flex flex-col gap-4" data-testid="transfer-done">
      <PageTop right={TITLE} />
      <div className="bg-apex-yellow text-apex-ink p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase">Pakiet przejęty</span>
        <span className="font-display font-extrabold text-4xl leading-none uppercase">Jesteś na liście</span>
        <span className="text-base font-semibold">{[done.event.name, dateLabel(done.event.date)].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="border border-apex-border-mid bg-apex-surface p-3.5">
        <span className="block text-lg font-bold text-apex-text-bright [overflow-wrap:anywhere]">{done.name}</span>
        <span className="block font-mono text-[13px] text-apex-muted uppercase">{done.competition}</span>
      </div>
      {/* Spec 14.17: the code was the login; onboarding waits for an ordinary one. */}
      <Link to={afterRegistrationPath({ slug, hasUsername: !!user?.username })} className={`${primaryBtn} flex items-center justify-center`}>
        Twój zapis
      </Link>
      <Link to={`${eventPath(slug)}/lista`} className={secondaryBtn}>Lista startowa</Link>
    </div>
  )
}

/** The preview's competition with the snapshot's age groups, or the preview's own limits when it is hidden. */
function contextFor(snapshot, preview, categoryId) {
  const comp = snapshot?.competitions?.find((c) => c.categoryId === categoryId) ?? null
  if (snapshot && comp) return { comp, ctx: personContext(snapshot, comp) }
  const own = preview.competitions.find((c) => c.categoryId === categoryId) ?? {}
  return {
    comp: null,
    ctx: {
      formFields: preview.formFields ?? {}, competition: { minAge: own.minAge ?? null, maxAge: own.maxAge ?? null, isKids: false },
      raceDate: preview.event.date, reckoning: snapshot?.ageReckoning ?? 'race_day', ageGroups: [], kidsGroups: [], now: new Date(),
    },
  }
}

function TransferForm({ preview, snapshot, draft, setDraft, errors, setErrors, consentError, setConsentError, message, busy, onSubmit, focus }) {
  const { user } = useAuth()
  const model = useMemo(() => (snapshot ? eventPageModel(snapshot) : null), [snapshot])
  const fields = fieldModes(preview.formFields)
  const { comp, ctx } = contextFor(snapshot, preview, draft.categoryId)
  const badge = closedBadge(preview)
  const ready = consentsComplete(preview.consents, draft.accepted, draft.serviceAccepted)
  const touched = useRef(new Set())

  // The field a refusal names, once the form is enabled again (a disabled input takes no focus).
  const focused = useRef(0)
  useEffect(() => {
    if (!focus || busy || focused.current === focus.n) return
    focused.current = focus.n
    const el = document.getElementById(focus.id)
    el?.focus()
    el?.scrollIntoView?.({ block: 'center' })
  }, [focus, busy])

  // A signed-in reader's own profile fills what they have not typed yet.
  useEffect(() => {
    if (!user) return
    setDraft((d) => ({ ...d, person: mergePrefill(d.person, profilePrefill(user), touched.current) }))
  }, [user, setDraft])

  const change = (patch) => {
    for (const k of Object.keys(patch)) touched.current.add(k)
    setDraft((d) => ({ ...d, person: { ...d.person, ...patch } }))
    setErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch)) delete next[k]
      return next
    })
  }

  return (
    <form onSubmit={(e) => onSubmit(e, ctx)} noValidate className="flex flex-col gap-[18px]" data-testid="transfer-accept">
      <PageTop right={TITLE} />
      {badge && (
        <span className="self-start border border-apex-cyan px-2 py-1 font-mono text-xs uppercase text-apex-cyan-text" data-testid="transfer-closed">{badge}</span>
      )}
      <EventStrip event={preview.event} />
      <h1 className="font-display font-extrabold text-[38px] leading-none uppercase text-apex-text-bright [overflow-wrap:anywhere]">
        {preview.senderFirstName} przekazuje Ci pakiet
      </h1>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={CATEGORY} className={labelCls}>{samePriceLabel(preview.priceLabel)}</label>
        <select id={CATEGORY} value={draft.categoryId} disabled={busy}
          onChange={(e) => { setDraft((d) => ({ ...d, categoryId: e.target.value })); setErrors((x) => ({ ...x, categoryId: undefined })) }}
          aria-invalid={errors.categoryId ? 'true' : undefined} aria-describedby={errors.categoryId ? `${CATEGORY}-error` : undefined}
          className={`${inputCls} ${errors.categoryId ? 'border-apex-red' : ''}`}>
          {preview.competitions.map((c) => <option key={c.categoryId} value={c.categoryId}>{optionLabel(c)}</option>)}
        </select>
        {errors.categoryId && <p id={`${CATEGORY}-error`} className="text-apex-red text-sm">{errors.categoryId}</p>}
      </div>
      <PersonForm fields={fields} value={draft.person} onChange={change} errors={errors} competition={comp}
        raceDate={ctx.raceDate} reckoning={ctx.reckoning} ageGroups={ctx.ageGroups} prefill={user ? profilePrefill(user) : null}
        loginHref={`/login?from=${encodeURIComponent(TRANSFER_PATH)}`} disabled={busy} variant="self" idPrefix="p" />
      <ConsentList consents={preview.consents} accepted={draft.accepted}
        onToggle={(id, v) => { setDraft((d) => ({ ...d, accepted: { ...d.accepted, [id]: v } })); setConsentError(null) }}
        serviceAccepted={draft.serviceAccepted} onService={(v) => { setDraft((d) => ({ ...d, serviceAccepted: v })); setConsentError(null) }}
        regulaminUrl={model?.regulaminUrl ?? preview.regulaminUrl ?? null} dataInfo={snapshot ? dataInfoOf(snapshot, model) : null} error={consentError} />
      <p className="text-lg font-bold text-apex-text-bright" data-testid="transfer-due">{DUE_LABEL}</p>
      {message && <p className="text-apex-red text-base" role="alert" data-testid="transfer-error">{message}</p>}
      <button type="submit" disabled={busy || !ready} className={primaryBtn}>{busy ? 'Chwileczkę…' : 'Przyjmij pakiet'}</button>
    </form>
  )
}

/** One transfer-accept read: → { data } or { err }. */
async function call(body) {
  try {
    return { data: (await callFunction('transfer-accept', body)).data }
  } catch (err) {
    return { err }
  }
}

export default function Przekazanie() {
  useSeo({ title: TITLE, path: TRANSFER_PATH, noindex: true })
  const { user } = useAuth()
  const token = useMemo(() => transferToken(), [])
  const [state, setState] = useState(() => (token ? { step: 'loading' } : { step: 'gone', message: GONE }))
  const [draft, setDraft] = useState({ categoryId: '', person: { ...EMPTY_PERSON }, accepted: {}, serviceAccepted: false })
  const [errors, setErrors] = useState({})
  const [consentError, setConsentError] = useState(null)
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState(null)
  const [resent, setResent] = useState(false)
  const [authKey, setAuthKey] = useState(0)
  const [verifiedEmail, setVerifiedEmail] = useState(null)
  const [focus, setFocus] = useState(null)
  const started = useRef(false)
  const preview = state.preview ?? null
  const snapshotState = usePublicRegistrationEvent(preview?.event?.slug ?? null)
  const snapshot = snapshotState.status === 'ok' ? snapshotState.raw : null

  const endLink = (err) => {
    forgetTransferToken()
    setState({ step: 'gone', message: acceptError(err) })
  }

  function load() {
    setState({ step: 'loading' })
    call({ token }).then(({ data, err }) => {
      if (data) {
        setDraft((d) => ({ ...d, categoryId: d.categoryId || data.competition.categoryId }))
        setState({ step: 'form', preview: data })
      } else if (err.code === 'refund_pending') {
        // The link still works once the refund is settled (V-87): the token stays for this tab.
        setState({ step: 'error', message: acceptError(err) })
      } else if (err.status === 409 || err.status === 400) {
        endLink(err)
      } else {
        setState({ step: 'error', message: acceptError(err) })
      }
    })
  }

  useEffect(() => {
    // One read on load, even under React's development double effects (10 calls a token an hour).
    if (!token || started.current) return
    started.current = true
    load()
  }, [token])

  /** A refusal of sendCode or accept, shown where it belongs. */
  function refused(err, { onCodeStep = false } = {}) {
    if (ENDS_LINK.has(err.code)) return endLink(err)
    const text = acceptError(err)
    const back = () => setState((s) => ({ step: 'form', preview: s.preview }))
    // A refusal that belongs to one field: shown under it, named by the button too (the field can
    // be a screen or more above it at 390 px), and the field gets the focus.
    const onField = (key, id) => {
      back()
      setErrors({ [key]: text })
      setMessage(text)
      setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))
    }
    if (ON_EMAIL.has(err.code)) return onField('email', 'p-email')
    if (err.code === 'recipient_minor') return onField('birthDate', 'p-birth')
    if (ON_CATEGORY.has(err.code)) return onField('categoryId', CATEGORY)
    if (err.code === 'invalid_person') { back(); setErrors(err.fields ?? {}); return setMessage(text) }
    if (err.code === 'consents_required' || err.code === 'consents_changed') { back(); return setConsentError(text) }
    return onCodeStep ? setCodeError(text) : setMessage(text)
  }

  async function sendCode({ again = false } = {}) {
    const { err } = await call({ token, sendCode: true, email: draft.person.email.trim() })
    if (err) return refused(err, { onCodeStep: again })
    setCode('')
    setCodeError(null)
    setFocus(null)
    setResent(again)
    setState((s) => ({ step: 'code', preview: s.preview }))
    return undefined
  }

  async function accept(withCode) {
    const body = {
      token, person: draft.person, categoryId: draft.categoryId,
      acceptedConsentIds: preview.consents.filter((c) => draft.accepted[c.id]).map((c) => c.id), serviceRegulamin: true,
      ...(withCode ? { code: withCode } : {}),
    }
    const { data, err } = await call(body)
    // The code was right when the answer is past the code check: the session cookie is set, and
    // this browser is now that person's. A second submit from the form needs no new code.
    if (withCode && (data || (err?.code && !BEFORE_CODE.has(err.code)))) {
      setVerifiedEmail(draft.person.email.trim())
      clearAuthCache()
      clearFavoritesCache()
      clearNotificationsCache()
      setAuthKey((k) => k + 1)
    }
    if (err) {
      if (err.code === 'code_required') return sendCode()
      return refused(err, { onCodeStep: !!withCode })
    }
    forgetTransferToken()
    const option = preview.competitions.find((c) => c.categoryId === draft.categoryId)
    setState({
      step: 'done', preview,
      done: { event: preview.event, name: `${draft.person.firstName} ${draft.person.lastName}`.trim(), competition: option ? optionLabel(option) : '' },
    })
    return undefined
  }

  async function submitForm(e, ctx) {
    e.preventDefault()
    if (busy) return
    setMessage(null)
    setConsentError(null)
    const checked = checkPerson(draft.person, ctx)
    if (!checked.ok) {
      setErrors(checked.errors)
      setMessage('Popraw zaznaczone pola.')
      return
    }
    setErrors({})
    setBusy(true)
    try {
      if (needsCode(user?.email, draft.person.email, verifiedEmail)) await sendCode()
      else await accept(null)
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(e) {
    e.preventDefault()
    if (busy || code.length !== 6) return
    setBusy(true)
    setCodeError(null)
    try {
      await accept(code)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setBusy(true)
    try { await sendCode({ again: true }) } finally { setBusy(false) }
  }

  let body
  if (state.step === 'loading') {
    body = (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="h-11 bg-apex-surface" /><div className="h-10 w-2/3 bg-apex-surface" /><div className="h-64 bg-apex-surface" />
      </div>
    )
  } else if (state.step === 'gone') {
    body = <Gone message={state.message} />
  } else if (state.step === 'error') {
    body = (
      <div className="flex flex-col gap-4" data-testid="transfer-load-error">
        <PageTop right={TITLE} />
        <p className="text-apex-red text-lg" role="alert">{state.message ?? OFFLINE}</p>
        <button type="button" onClick={load} className={secondaryBtn}>Spróbuj ponownie</button>
      </div>
    )
  } else if (state.step === 'code') {
    body = (
      <>
        <PageTop back={{ onClick: () => setState((s) => ({ step: 'form', preview: s.preview })), label: 'Wróć' }} right={TITLE} />
        <CodeStep email={draft.person.email.trim()} code={code} onCode={setCode} error={codeError} busy={busy}
          onSubmit={submitCode} onResend={resend} resent={resent}
          onChangeAddress={() => setState((s) => ({ step: 'form', preview: s.preview }))} submitLabel="Przyjmij pakiet" />
      </>
    )
  } else if (state.step === 'done') {
    body = <Done done={state.done} />
  } else if (snapshotState.status === 'loading') {
    body = <div className="flex flex-col gap-4" aria-busy="true"><div className="h-24 bg-apex-surface" /><div className="h-64 bg-apex-surface" /></div>
  } else if (!snapshot) {
    // The data information and the age groups come from the event's snapshot: without it the reader
    // would tick „Znam informację o danych” against nothing. The token is kept for the tab.
    body = (
      <div className="flex flex-col gap-4" data-testid="transfer-event-error">
        <PageTop right={TITLE} />
        <p className="text-apex-red text-lg" role="alert">Nie udało się wczytać danych zawodów.</p>
        <button type="button" onClick={() => window.location.reload()} className={secondaryBtn}>Spróbuj ponownie</button>
      </div>
    )
  } else {
    body = (
      <TransferForm preview={preview} snapshot={snapshot} draft={draft} setDraft={setDraft} errors={errors} setErrors={setErrors}
        consentError={consentError} setConsentError={setConsentError} message={message} busy={busy} onSubmit={submitForm} focus={focus} />
    )
  }
  return <Shell authKey={authKey}>{body}</Shell>
}
