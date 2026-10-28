import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useAuth, { clearAuthCache } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import useSeo from '../../hooks/useSeo.js'
import { forgetPublicRegistrationEvent } from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction, requestCode } from '../../lib/auth.js'
import { afterRegistrationPath } from '../../lib/inviteLink.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import {
  EMPTY_PERSON, profilePrefill, fieldModes, personContext, checkPerson, needsCode, consentsComplete, registerBody,
  registrationFailure,
} from '../../lib/personFormModel.js'
import { runnerDataInfo } from '../../legal/runnerDataInfo.js'
import PersonForm from '../../components/registration/PersonForm.jsx'
import ConsentList from '../../components/registration/ConsentList.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import { inputCls, labelCls, primaryBtn } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import { eventPath, formPath } from './RegistrationEventPage.jsx'

// RA2 (free events): the person form and the consents → „Dalej” → the e-mail
// code (auth-request-code, with the login form's honeypot) → register-free →
// RA5. A session holding the person's own address skips the code: the button
// reads „Zapisz się” and registers at once. Nothing about the person goes in
// the address bar.

export const donePath = (slug) => `/events/${slug}/zapisano`

function CodeStep({ email, code, onCode, error, busy, onSubmit, onResend, onChangeAddress, resent }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" data-testid="code-step">
      <h1 className="font-display font-extrabold text-[38px] leading-none uppercase text-apex-text-bright">Sprawdź skrzynkę</h1>
      <p className="text-lg leading-snug">
        Wysłaliśmy 6-cyfrowy kod na <strong className="text-apex-text-bright break-all">{email}</strong>. Bez niego zgłoszenie nie powstanie.
      </p>
      <p className="text-sm text-apex-text border-l-2 border-apex-yellow pl-3">
        Nie widzisz maila? Zajrzyj do spamu i zakładek typu Oferty, Promocje czy Newslettery.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reg-code" className={labelCls}>Kod (6 cyfr)</label>
        <input id="reg-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required autoFocus
          value={code} onChange={(e) => onCode(e.target.value.replace(/\D/g, ''))}
          className={`${inputCls} font-mono text-2xl tracking-[0.5em] h-14 ${error ? 'border-apex-red' : ''}`} />
        {error && <p className="text-apex-red text-sm">{error}</p>}
      </div>
      <button type="submit" disabled={busy || code.length !== 6} className={primaryBtn}>
        {busy ? 'Zapisujemy…' : 'Zapisz się'}
      </button>
      <div className="flex justify-between gap-3">
        <button type="button" onClick={onResend} disabled={busy} className="min-h-11 text-base text-apex-yellow whitespace-nowrap disabled:opacity-40">
          {resent ? 'Wysłano ponownie' : 'Wyślij ponownie'}
        </button>
        <button type="button" onClick={onChangeAddress} disabled={busy} className="min-h-11 text-base text-apex-muted whitespace-nowrap">Zmień adres</button>
      </div>
      <div className="border border-apex-border bg-apex-surface p-3.5 flex flex-col gap-1.5">
        <span className={labelCls}>Dlaczego kod?</span>
        <span className="text-base leading-snug">
          Sprawdzamy, że adres jest Twój — tu przyjdzie potwierdzenie zapisu i wiadomości od organizatora. Kod loguje Cię też do LESZY.RUN; konto powstaje samo.
        </span>
      </div>
    </form>
  )
}

/**
 * The form for one competition. `preview` (organizer „Podgląd jako zawodnik”)
 * renders everything with the submit disabled.
 */
export function ZapisView({ raw, categoryId, preview = false, backTo }) {
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const model = useMemo(() => eventPageModel(raw), [raw])
  const competition = raw.competitions.find((c) => c.categoryId === categoryId)
  const row = model.competitions.find((c) => c.categoryId === categoryId)
  const ctx = useMemo(() => (competition ? personContext(raw, competition) : null), [raw, competition])
  const fields = fieldModes(raw.formFields)
  const consents = raw.consents ?? []

  const [step, setStep] = useState('form')
  const [person, setPerson] = useState({ ...EMPTY_PERSON })
  const [errors, setErrors] = useState({})
  const [message, setMessage] = useState(null)
  const [accepted, setAccepted] = useState({})
  const [serviceAccepted, setServiceAccepted] = useState(false)
  const [honeypot, setHoneypot] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState(null)
  const [resent, setResent] = useState(false)
  const [busy, setBusy] = useState(false)
  const touched = useRef(false)

  // The logged-in person's own profile fills the form once, before they type.
  const prefill = useMemo(() => (user ? profilePrefill(user) : null), [user])
  useEffect(() => {
    if (prefill && !touched.current) setPerson((p) => ({ ...p, ...prefill }))
  }, [prefill])

  if (!competition || !row) {
    return (
      <div className="flex flex-col gap-4" data-testid="competition-unavailable">
        <PageTop back={backTo ? { to: backTo, label: 'Konkurencje' } : null} right={model.title} />
        <p className="text-lg text-apex-text-bright">Ta konkurencja nie przyjmuje zapisów.</p>
      </div>
    )
  }

  const open = row.state === 'open'
  const codeNeeded = needsCode(user?.email, person.email)
  const ready = consentsComplete(consents, accepted, serviceAccepted)
  const dataInfo = runnerDataInfo({
    eventName: model.title, organizerName: model.organizerName, contactEmail: model.contactEmail,
    paid: raw.pricingMode !== 'free', teams: raw.competitions.some((c) => c.kind === 'team'),
  })

  const change = (patch) => {
    touched.current = true
    setPerson((p) => ({ ...p, ...patch }))
    setErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch)) delete next[k]
      return next
    })
  }

  const fail = (err, value) => {
    const f = registrationFailure(err)
    if (f.step === 'code' && !sentTo) {
      // The session ended between page load and submit: no code was ever sent.
      // Stay on the form and send one now.
      if (value) return startCode(value.email)
      setStep('form')
      setMessage(f.fields.code)
      return undefined
    }
    setStep(f.step)
    setMessage(f.message)
    if (f.step === 'code') setErrors((e) => ({ ...e, code: f.fields.code }))
    else setErrors(f.fields)
  }

  async function register(value, withCode) {
    setBusy(true)
    try {
      await callFunction('register-free', registerBody({ categoryId, person: value, consents, code: withCode }))
      // register-free set the session cookie: drop whatever the browser cached about the previous visitor.
      clearAuthCache()
      clearFavoritesCache()
      clearNotificationsCache()
      forgetPublicRegistrationEvent(raw.slug)
      // Spec 14.17: the account register-free just opened skips onboarding here, and only here.
      navigate(afterRegistrationPath({ slug: raw.slug, hasUsername: !!user?.username }), { replace: true })
    } catch (err) {
      setBusy(false)
      await fail(err, value)
    }
  }

  async function sendCode(email) {
    await requestCode(email, honeypot, formPath(raw.slug, categoryId))
  }

  async function onSubmitForm(e) {
    e.preventDefault()
    if (preview || busy || !ready) return
    setMessage(null)
    const r = checkPerson(person, ctx)
    if (!r.ok) {
      setErrors(r.errors)
      setMessage('Popraw zaznaczone pola.')
      return
    }
    if (!codeNeeded) return register(r.value, null)
    return startCode(r.value.email)
  }

  async function startCode(email) {
    setBusy(true)
    try {
      await sendCode(email)
      setSentTo(email)
      setCode('')
      setResent(false)
      setErrors({})
      setStep('code')
    } catch (err) {
      setStep('form')
      const f = registrationFailure(err)
      setErrors(f.fields)
      setMessage(f.message)
    } finally {
      setBusy(false)
    }
  }

  async function onSubmitCode(e) {
    e.preventDefault()
    const r = checkPerson(person, ctx)
    if (!r.ok) { setErrors(r.errors); setStep('form'); return }
    await register(r.value, code)
  }

  async function onResend() {
    setErrors((x) => ({ ...x, code: undefined }))
    if (!sentTo) { setStep('form'); return }
    try {
      await sendCode(sentTo)
      setResent(true)
    } catch (err) {
      fail(err)
    }
  }

  if (step === 'code' && sentTo) {
    return (
      <div className="flex flex-col gap-4">
        <PageTop right="KROK 2/3" />
        <CodeStep email={sentTo} code={code} onCode={setCode} error={errors.code} busy={busy} resent={resent}
          onSubmit={onSubmitCode} onResend={onResend} onChangeAddress={() => { setStep('form'); setErrors({}) }} />
      </div>
    )
  }

  return (
    <form onSubmit={onSubmitForm} noValidate className="flex flex-col gap-[18px]" data-testid="registration-form">
      <PageTop back={backTo ? { to: backTo, label: 'Konkurencje' } : null} right="KROK 1/3" />
      <div className="border border-apex-yellow px-3.5 py-3 flex justify-between items-center gap-3">
        <span className="text-lg font-bold text-apex-text-bright">{row.name}</span>
        <span className="font-mono text-apex-yellow whitespace-nowrap">{row.priceLabel}</span>
      </div>
      {!open && !preview && <p className="text-apex-red text-base">Zapisy na tę konkurencję są zamknięte.</p>}

      {/* Honeypot, as on the login form: hidden from people, filled by bots. */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>

      <PersonForm fields={fields} value={person} onChange={change} errors={errors} competition={competition}
        raceDate={ctx.raceDate} reckoning={ctx.reckoning} ageGroups={ctx.ageGroups}
        prefill={authLoading ? {} : prefill} disabled={busy}
        loginHref={`/login?from=${encodeURIComponent(formPath(raw.slug, categoryId))}`}
        codeNote={codeNeeded ? 'Wyślemy na niego kod potwierdzający zapis.' : 'Jesteś zalogowany na ten adres — bez kodu.'} />

      <ConsentList consents={consents} accepted={accepted} onToggle={(id, v) => setAccepted((a) => ({ ...a, [id]: v }))}
        serviceAccepted={serviceAccepted} onService={setServiceAccepted} regulaminUrl={model.regulaminUrl} dataInfo={dataInfo} />

      {message && <p className="text-apex-red text-base" role="alert">{message}</p>}
      <button type="submit" data-testid="registration-submit" disabled={preview || busy || !ready || !open} className={primaryBtn}>
        {busy ? 'Chwileczkę…' : codeNeeded ? 'Dalej' : 'Zapisz się'}
      </button>
    </form>
  )
}

function Seo({ raw }) {
  useSeo({ title: `Zapis — ${raw.name}`, path: eventPath(raw.slug), noindex: true })
  return null
}

export default function Zapis() {
  const { slug, categoryId } = useParams()
  return (
    <RegistrationShell slug={slug}>
      {(raw) => <><Seo raw={raw} /><ZapisView raw={raw} categoryId={categoryId} backTo={eventPath(raw.slug)} /></>}
    </RegistrationShell>
  )
}
