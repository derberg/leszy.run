import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../../components/Navbar.jsx'
import useAuth, { clearAuthCache } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import useSeo from '../../hooks/useSeo.js'
import usePublicRegistrationEvent from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction } from '../../lib/auth.js'
import { consentToken, forgetConsentToken } from '../../lib/consentToken.js'
import { dataInfoOf } from '../../lib/dataInfo.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import { postAuthPath } from '../../lib/inviteLink.js'
import { fieldModes, personContext } from '../../lib/personFormModel.js'
import PersonForm from '../../components/registration/PersonForm.jsx'
import ConsentList from '../../components/registration/ConsentList.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import { inputCls, labelCls, primaryBtn, secondaryBtn } from '../../components/registration/ui.js'
import { eventPath } from './RegistrationEventPage.jsx'

// /zgoda#<token>: an adult somebody else registered accepts the regulamin (Plan 4, task 6).
// main.jsx has already taken the token out of the address bar (consentToken.js), so nothing
// below can leak it. The link alone shows the event and the first name (ruling 11); the
// person's data, the edit form and the consents come only after the e-mail code, or at once to
// a session whose address is the registration's. Every event consent and the LESZY.RUN service
// regulamin are required boxes, as on the registration form. The person may correct their data
// until registration closes (`editable`); the e-mail is never edited here.
//
// API: consent-request { token, sendCode?, code? } and accept-consent { token,
// acceptedConsentIds, shownConsentIds, serviceRegulamin: true, edits? }; the contract is in the
// functions' headers. The per-token limit is 30 calls an hour, so the page reads once on load and
// otherwise only on the person's action.

const GONE_LINK = 'Ten link został już użyty albo wygasł.'
const EDIT_KEYS = ['firstName', 'lastName', 'birthDate', 'gender', 'phone', 'city', 'club', 'iceName', 'icePhone', 'nationality']

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

/** The event strip shared by every step: name, date, competition and its start. */
function EventStrip({ event, competition }) {
  return (
    <div className="border border-apex-yellow px-3.5 py-3 flex flex-col gap-0.5" data-testid="consent-event">
      <span className="text-lg font-bold text-apex-text-bright">{event.name}</span>
      <span className="font-mono text-[13px] text-apex-muted uppercase">
        {[dateLabel(event.date), competition?.name, competition?.startTime ? `start ${competition.startTime}` : null].filter(Boolean).join(' · ')}
      </span>
    </div>
  )
}

function CodeStep({ info, sent, code, onCode, error, busy, stale, onSend, onSubmit }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" data-testid="consent-code-step">
      <PageTop right="Akceptacja regulaminu" />
      <EventStrip event={info.event} competition={info.competition} />
      <h1 className="font-display font-extrabold text-[38px] leading-none uppercase text-apex-text-bright">Cześć, {info.firstName}</h1>
      <p className="text-lg leading-snug">
        Ktoś zapisał Cię na te zawody. Zanim wystartujesz, zaakceptuj regulamin i sprawdź swoje dane.
      </p>
      {!sent && (
        <>
          <p className="text-lg leading-snug">
            Wyślemy kod na <strong className="text-apex-text-bright break-all">{info.emailHint}</strong>.
          </p>
          {error && <p className="text-apex-red text-sm" role="alert" data-testid="consent-code-error">{error}</p>}
          <button type="button" onClick={onSend} disabled={busy} className={primaryBtn}>{busy ? 'Wysyłamy…' : 'Wyślij kod'}</button>
        </>
      )}
      {sent && (
        <>
          <p className="text-lg leading-snug">
            Wysłaliśmy 6-cyfrowy kod na <strong className="text-apex-text-bright break-all">{info.emailHint}</strong>.
          </p>
          <p className="text-lg leading-snug" data-testid="consent-code-hint">Wpisz kod z e-maila w polu poniżej.</p>
          <p className="text-sm text-apex-text border-l-2 border-apex-yellow pl-3">
            Nie widzisz maila? Zajrzyj do spamu i zakładek typu Oferty, Promocje czy Newslettery.
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="consent-code" className={labelCls}>Kod (6 cyfr)</label>
            <input id="consent-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required autoFocus
              value={code} onChange={(e) => onCode(e.target.value.replace(/\D/g, ''))}
              aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'consent-code-error' : undefined}
              className={`${inputCls} font-mono text-2xl tracking-[0.5em] h-14 ${error ? 'border-apex-red' : ''}`} />
            {error && <p id="consent-code-error" className="text-apex-red text-sm" role="alert" data-testid="consent-code-error">{error}</p>}
          </div>
          <button type="submit" disabled={busy || code.length !== 6} className={primaryBtn}>{busy ? 'Sprawdzamy…' : 'Dalej'}</button>
          <button type="button" onClick={onSend} disabled={busy}
            className={`min-h-11 self-start text-base whitespace-nowrap disabled:opacity-40 ${stale ? 'text-apex-yellow font-bold' : 'text-apex-yellow'}`}>
            Wyślij nowy kod
          </button>
        </>
      )}
      <div className="border border-apex-border bg-apex-surface p-3.5 flex flex-col gap-1.5">
        <span className={labelCls}>Dlaczego kod?</span>
        <span className="text-base leading-snug">
          Link mógł trafić do kogoś innego. Twoje dane pokażemy dopiero temu, kto ma dostęp do Twojej skrzynki. Kod loguje Cię też do LESZY.RUN; konto powstaje samo.
        </span>
      </div>
    </form>
  )
}

function Gone({ message }) {
  return (
    <div className="flex flex-col gap-4" data-testid="consent-gone">
      <PageTop right="Akceptacja regulaminu" />
      <h1 className="font-display font-extrabold text-[34px] leading-none uppercase text-apex-text-bright">Link nieaktywny</h1>
      <p className="text-lg text-apex-text-bright">{message}</p>
      <p className="text-base">Nowy link wyśle osoba, która Cię zapisała, albo organizator zawodów.</p>
      <Link to="/" className={secondaryBtn}>Strona główna</Link>
    </div>
  )
}

function Done({ info }) {
  const { user } = useAuth()
  const slug = info.event.slug
  return (
    <div className="flex flex-col gap-4" data-testid="consent-done">
      <PageTop right="Akceptacja regulaminu" />
      <div className="bg-apex-yellow text-apex-ink p-[18px] flex flex-col gap-1">
        <span className="font-mono text-xs uppercase">Zapis potwierdzony</span>
        <span className="font-display font-extrabold text-3xl sm:text-4xl leading-none uppercase">Dziękujemy — regulamin zaakceptowany.</span>
        <span className="text-base font-semibold">{[info.event.name, dateLabel(info.event.date)].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="border border-apex-border-mid bg-apex-surface p-3.5">
        <span className="block text-lg font-bold text-apex-text-bright">{info.person.firstName} {info.person.lastName}</span>
        <span className="block font-mono text-[13px] text-apex-muted uppercase">
          {[info.competition?.name, info.competition?.startTime ? `start ${info.competition.startTime}` : null].filter(Boolean).join(' · ')}
        </span>
      </div>
      {/* Spec 14.17 / P2-R22: the code was the login; onboarding waits for an ordinary one. */}
      <Link to={postAuthPath({ from: eventPath(slug), hasUsername: !!user?.username, skipOnboarding: true })} className={primaryBtn + ' flex items-center justify-center'}>
        Strona zawodów
      </Link>
      <Link to={`${eventPath(slug)}/lista`} className={secondaryBtn}>Lista startowa</Link>
    </div>
  )
}

/** The person as the form edits it: strings for the inputs (null → ''). */
const asForm = (p) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, v ?? '']))

/** The changed fields only, '' sent as null; {} when nothing changed. */
function editsOf(original, current) {
  const out = {}
  for (const k of EDIT_KEYS) {
    const before = original[k] ?? ''
    const after = current[k] ?? ''
    if (String(before) !== String(after)) out[k] = after === '' ? null : after
  }
  return out
}

/**
 * The event's public snapshot (/api/event) is what the data information, the regulamin link and the
 * age-group preview come from. Without it the person would tick „Znam informację o danych” against
 * an incomplete text, so the form waits for it, and a failure offers „Spróbuj ponownie”.
 */
function SnapshotLoader({ slug, onRetry, children }) {
  const { status, raw } = usePublicRegistrationEvent(slug)
  if (status === 'loading') {
    return <div className="flex flex-col gap-4" aria-busy="true"><div className="h-24 bg-apex-surface" /><div className="h-64 bg-apex-surface" /></div>
  }
  if (status !== 'ok') {
    return (
      <div className="flex flex-col gap-4" data-testid="consent-event-error">
        <PageTop right="Akceptacja regulaminu" />
        <p className="text-apex-red text-lg" role="alert">Nie udało się wczytać danych zawodów.</p>
        <button type="button" onClick={onRetry} className={secondaryBtn}>Spróbuj ponownie</button>
      </div>
    )
  }
  return children(raw)
}

function ConsentStep(props) {
  // A failed snapshot is not cached (usePublicRegistrationEvent), so mounting the loader again retries it.
  const [attempt, setAttempt] = useState(0)
  return (
    <SnapshotLoader key={attempt} slug={props.answer.event.slug} onRetry={() => setAttempt((a) => a + 1)}>
      {(snapshot) => <ConsentForm {...props} snapshot={snapshot} />}
    </SnapshotLoader>
  )
}

function ConsentForm({ token, answer, snapshot, onAccepted, onRefused, onSessionGone, onReread }) {
  const model = useMemo(() => eventPageModel(snapshot), [snapshot])
  const comp = snapshot.competitions?.find((c) => c.categoryId === answer.competition.categoryId) ?? null
  const ctx = comp ? personContext(snapshot, comp) : null
  const fields = fieldModes(answer.formFields)
  const dataInfo = dataInfoOf(snapshot, model)

  const original = useMemo(() => asForm(answer.person), [answer.person])
  const [person, setPerson] = useState(original)
  const [editable, setEditable] = useState(answer.editable)
  const [consents, setConsents] = useState(answer.consents)
  const [errors, setErrors] = useState({})
  const [accepted, setAccepted] = useState({})
  const [serviceAccepted, setServiceAccepted] = useState(false)
  const [consentError, setConsentError] = useState(null)
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  const ready = serviceAccepted && consents.every((c) => accepted[c.id] === true)

  const change = (patch) => {
    setPerson((p) => ({ ...p, ...patch }))
    setErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch)) delete next[k]
      return next
    })
  }

  const closeEdits = () => {
    setEditable(false)
    setPerson(original)
    setErrors({})
  }

  // The organizer changed the consents while the page was open: the current ones, all unticked,
  // in place of the old ones. The person's data stays as they typed it.
  async function consentsChanged(notice) {
    const fresh = await onReread()
    if (!fresh) return
    setConsents(fresh.consents)
    setAccepted({})
    setServiceAccepted(false)
    setConsentError(notice)
    if (!fresh.editable) closeEdits()
  }

  async function onSubmit(e) {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true)
    setMessage(null)
    setConsentError(null)
    const edits = editable ? editsOf(original, person) : {}
    try {
      await callFunction('accept-consent', {
        token,
        acceptedConsentIds: consents.filter((c) => accepted[c.id]).map((c) => c.id),
        shownConsentIds: consents.map((c) => c.id),
        serviceRegulamin: true,
        ...(Object.keys(edits).length ? { edits } : {}),
      })
      onAccepted({ ...answer, person: { ...answer.person, ...edits } })
    } catch (err) {
      setBusy(false)
      if (err.status === 410 || err.status === 409) return onRefused(err)
      if (err.status === 403 && err.code === 'session_required') return onSessionGone()
      if (err.code === 'consents_changed') return consentsChanged(err.message)
      if (err.code === 'consents_required') return setConsentError(err.message)
      if (err.code === 'edits_closed') {
        closeEdits()
        return setMessage(err.message)
      }
      if (err.code === 'edit_invalid' && err.fields) {
        setErrors(err.fields)
        return setMessage('Popraw zaznaczone pola.')
      }
      setMessage(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
    }
    return undefined
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-[18px]" data-testid="consent-form">
      <PageTop right="Akceptacja regulaminu" />
      <EventStrip event={answer.event} competition={answer.competition} />
      <h1 className="font-display font-extrabold text-[38px] leading-none uppercase text-apex-text-bright">Sprawdź dane</h1>
      {!editable && (
        <p className="text-base border-l-2 border-apex-yellow pl-3" data-testid="consent-edits-closed">
          Zapisy są zamknięte. Dane poprawisz w biurze zawodów.
        </p>
      )}
      <PersonForm fields={fields} value={person} onChange={change} errors={errors} competition={comp}
        raceDate={ctx?.raceDate ?? answer.event.date} reckoning={ctx?.reckoning ?? 'race_day'} ageGroups={ctx?.ageGroups ?? []}
        prefill={null} disabled={busy || !editable} variant="self" idPrefix="p" emailReadOnly />
      <ConsentList consents={consents} accepted={accepted} onToggle={(id, v) => { setAccepted((a) => ({ ...a, [id]: v })); setConsentError(null) }}
        serviceAccepted={serviceAccepted} onService={(v) => { setServiceAccepted(v); setConsentError(null) }}
        regulaminUrl={model.regulaminUrl ?? answer.regulaminUrl ?? null} dataInfo={dataInfo} error={consentError} />
      {message && <p className="text-apex-red text-base" role="alert" data-testid="consent-error">{message}</p>}
      <button type="submit" disabled={busy || !ready} className={primaryBtn}>{busy ? 'Zapisujemy…' : 'Akceptuję regulamin'}</button>
    </form>
  )
}

const OFFLINE = 'Nie udało się połączyć. Spróbuj ponownie.'

function useConsentPage() {
  const token = useMemo(() => consentToken(), [])
  const [state, setState] = useState(() => (token ? { step: 'loading' } : { step: 'gone', message: GONE_LINK }))
  const started = useRef(false)

  const refuse = (err) => {
    forgetConsentToken()
    setState({ step: 'gone', message: err.message || GONE_LINK })
  }

  /** One consent-request; → the answer, or null after a refusal it handled. */
  async function read(extra = {}) {
    try {
      const r = await callFunction('consent-request', { token, ...extra })
      return r.data
    } catch (err) {
      if (err.status === 410 || err.status === 409) { refuse(err); return null }
      throw err
    }
  }

  const show = (data, extra = {}) => setState(data.needsCode ? { step: 'code', info: data, ...extra } : { step: 'form', answer: data })

  /** The page's read: on load, and from „Spróbuj ponownie” on the error step. */
  function load() {
    setState({ step: 'loading' })
    read()
      .then((data) => { if (data) show(data) })
      .catch((err) => setState({ step: 'error', message: err.status == null ? OFFLINE : err.message }))
  }

  useEffect(() => {
    // One read on load, even under React's development double effects (the token's limit is 30 an hour).
    if (!token || started.current) return
    started.current = true
    load()
  }, [token])

  return { token, state, setState, read, show, refuse, load }
}

export default function Zgoda() {
  useSeo({ title: 'Akceptacja regulaminu', path: '/zgoda', noindex: true })
  const { token, state, setState, read, show, refuse, load } = useConsentPage()
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  // Bumped when the code opens the session: the Navbar mounts again and reads who is signed in,
  // as it does after every navigation from /login.
  const [authKey, setAuthKey] = useState(0)

  const codeFailed = (err) => {
    // A retired address can never finish this link: the tab need not keep it.
    if (err.code === 'email_retired') forgetConsentToken()
    setCodeError(err.status == null ? OFFLINE : err.message)
  }

  async function sendCode() {
    setBusy(true)
    setCodeError(null)
    try {
      const data = await read({ sendCode: true })
      if (data) {
        setCode('')
        setStale(false)
        show(data, { sent: true })
      }
    } catch (err) {
      codeFailed(err)
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
      const data = await read({ code })
      if (data) {
        // The code opened this person's session: drop whatever the browser cached about the previous visitor.
        clearAuthCache()
        clearFavoritesCache()
        clearNotificationsCache()
        setAuthKey((k) => k + 1)
        show(data, { sent: true })
      }
    } catch (err) {
      // After three wrong codes the right one is refused too (403): a new code is the way on.
      setStale(err.status === 403 && err.code !== 'email_retired')
      codeFailed(err)
    } finally {
      setBusy(false)
    }
  }

  /** consent-request again for the form: → the full answer, or null (code step, refusal or error shown instead). */
  async function reread() {
    try {
      const data = await read()
      if (!data) return null
      if (data.needsCode) { show(data); return null }
      return data
    } catch (err) {
      setState({ step: 'error', message: err.status == null ? OFFLINE : err.message })
      return null
    }
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
      <div className="flex flex-col gap-4" data-testid="consent-load-error">
        <PageTop right="Akceptacja regulaminu" />
        <p className="text-apex-red text-lg" role="alert" data-testid="consent-error">{state.message}</p>
        <button type="button" onClick={load} className={secondaryBtn}>Spróbuj ponownie</button>
      </div>
    )
  } else if (state.step === 'code') {
    body = (
      <CodeStep info={state.info} sent={!!state.sent} code={code} onCode={setCode} error={codeError} busy={busy} stale={stale}
        onSend={sendCode} onSubmit={submitCode} />
    )
  } else if (state.step === 'form') {
    body = (
      <ConsentStep token={token} answer={state.answer}
        onAccepted={(answer) => { forgetConsentToken(); setState({ step: 'done', answer }) }}
        onRefused={refuse} onReread={reread}
        onSessionGone={async () => { const d = await reread(); if (d) show(d) }} />
    )
  } else {
    body = <Done info={state.answer} />
  }
  return <Shell authKey={authKey}>{body}</Shell>
}
