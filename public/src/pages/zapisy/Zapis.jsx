import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useAuth, { clearAuthCache, resolveUser } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import useSeo from '../../hooks/useSeo.js'
import { forgetPublicRegistrationEvent } from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction, requestCode, verifyCode } from '../../lib/auth.js'
import { afterRegistrationPath } from '../../lib/inviteLink.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import {
  profilePrefill, mergePrefill, fieldModes, personContext, needsCode, categoryPreview, kidsGroupLabel,
} from '../../lib/personFormModel.js'
import {
  newDraft, addPerson, removePerson, updatePerson, setCardCompetition, setCardOpen, setGuardianConsent, setNotRunning,
  cardVariants, effectivePerson, peopleCount, canAdd, toRequest, claimedEmail, checkDraft, draftReady, groupFailure,
  cardEmpty, cardName, erroredCards, fixMessage, formStep, stepAfter, LIST_STEP, addableCompetitions,
} from '../../lib/groupDraft.js'
import { useLeaveGuard, confirmLeave } from '../../lib/leaveGuard.js'
import { focusCardError, useStepHistory } from '../../lib/useStepHistory.js'
import { countPl } from '../../lib/plural.js'
import { warsawToday } from '@registration/dates.js'
import { runnerDataInfo } from '../../legal/runnerDataInfo.js'
import PersonForm from '../../components/registration/PersonForm.jsx'
import ConsentList from '../../components/registration/ConsentList.jsx'
import CodeStep from '../../components/registration/CodeStep.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import { PersonRow, RemoveConfirm } from '../../components/registration/PersonRow.jsx'
import { inputCls, labelCls, primaryBtn, removeBtn, sectionCls, secondaryBtn } from '../../components/registration/ui.js'
import RegistrationShell from './RegistrationShell.jsx'
import Podsumowanie from './Podsumowanie.jsx'
import TeamSignup from './TeamSignup.jsx'
import { eventPath, formPath } from './RegistrationEventPage.jsx'

// RA2: one runner sees their card and the consents on one page. A group goes one person at
// a time (`formStep` in groupDraft.js): each person's step shows that person alone, and the
// list step shows who is in the request, with „Zmień” / „Usuń” and the consents. „Dalej” → the
// e-mail code (auth-request-code, with the login form's honeypot). A free event then calls
// register-free → RA5. A paid event (pricingMode !== 'free') goes on to RA4
// (Podsumowanie), whose „Zapłać” calls create-order with the same body plus
// the total, and hands the browser to dpay; the order page
// (/zamowienie/:orderId) is RA5 for it. For a paid event the code is checked
// at the code step itself (auth-verify-code opens the session there), so a
// wrong, expired, used-up or throttled code is answered where „Wyślij
// ponownie” is, and RA4 always runs on the person's own session. A session
// holding the address of card 1 (the one registering, or the payer with „Nie
// startuję”) skips the code. Nothing about anybody goes in the address bar.

export const donePath = (slug) => `/events/${slug}/zapisano`

const ADULT_NOTE = 'Ta osoba dostanie e-mail z prośbą o akceptację regulaminu.'
/**
 * The form for one competition, and the group built on it (RA2, RA3): card 1 is „Twoje dane”
 * (or, with „Nie startuję”, only the payer and guardian), „+ Zapisz kolejną osobę” adds a
 * person with their own competition on a step of their own, a child's card (under 18 today,
 * Warsaw) drops the e-mail and asks for the guardian's box. Leaving a person forward checks them
 * first, so an error is answered on that person's own step. The draft is in memory only
 * (groupDraft.js); a page with a second person asks before it is closed. `preview` (organizer
 * „Podgląd jako zawodnik”) renders everything with the submit disabled.
 */
function PersonSignup({ raw, categoryId, preview = false, backTo }) {
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const model = useMemo(() => eventPageModel(raw), [raw])
  const competition = raw.competitions.find((c) => c.categoryId === categoryId)
  const row = model.competitions.find((c) => c.categoryId === categoryId)
  const contexts = useMemo(() => new Map(raw.competitions.map((c) => [c.categoryId, personContext(raw, c)])), [raw])
  const fields = fieldModes(raw.formFields)
  const consents = raw.consents ?? []
  // Competitions a further person may pick: the open individual ones, in the event page's order.
  const choices = useMemo(() => addableCompetitions(model), [model])

  const [step, setStep] = useState('form')
  const [draft, setDraft] = useState(() => newDraft(categoryId))
  // Which step of the group form is on screen: LIST_STEP or a card's key (see formStep).
  const [at, setAt] = useState(LIST_STEP)
  const [errors, setErrors] = useState({})
  const [codeError, setCodeError] = useState(null)
  const [message, setMessage] = useState(null)
  const [accepted, setAccepted] = useState({})
  const [serviceAccepted, setServiceAccepted] = useState(false)
  const [honeypot, setHoneypot] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState(null)
  const [resent, setResent] = useState(false)
  const [busy, setBusy] = useState(false)
  // RA4's prices after a price_changed, per competition (N-3): a trip back to the form and on
  // to RA4 again shows the server's prices, not the page's older ones.
  const [priceOf, setPriceOf] = useState({})
  // The address the code step verified (paid events): the session it opened may not be in the
  // auth cache yet, and „Wróć” then „Dalej” must not send another code (N1).
  const [verifiedEmail, setVerifiedEmail] = useState(null)
  // Fields of card 1 the person has typed into or picked. The profile never overwrites
  // them, and fills every other field even when it lands after they started:
  // on a slow phone the sign-in check can arrive well after the first keystroke.
  const touched = useRef(new Set())
  // The card whose first invalid field takes the focus once the errors are on screen (I-1).
  const errorFocus = useRef(null)
  // The card asking „Usunąć tę osobę?” (M-6).
  const [removing, setRemoving] = useState(null)

  // The logged-in person's own profile fills card 1, field by field, and nobody else's.
  const prefill = useMemo(() => (user ? profilePrefill(user) : null), [user])
  useEffect(() => {
    if (!prefill) return
    setDraft((d) => {
      const first = d.cards[0]
      return { ...d, cards: [{ ...first, person: mergePrefill(first.person, prefill, touched.current) }, ...d.cards.slice(1)] }
    })
  }, [prefill])

  // A second person exists: closing the tab or reloading would lose the group (memory only).
  // It holds on RA4 too; Podsumowanie lifts it right before the redirect to dpay.
  const guard = draft.cards.length > 1 && !preview
  useLeaveGuard(guard)

  // A new step starts at the top, on its first field; the list on its heading. A refusal
  // moves the focus itself, in the next effect.
  const view = formStep(draft, at)
  const stepId = view.kind === 'list' ? LIST_STEP : draft.cards[view.index ?? 0].key
  useStepHistory({
    id: step === 'form' ? stepId : step,
    state: { step, at: stepId },
    guard,
    onEnter: () => {
      if (step !== 'form' || errorFocus.current) return
      window.scrollTo({ top: 0, behavior: 'instant' })
      const target = view.kind === 'list' ? 'group-list-heading' : `${view.index ? `p${view.index + 1}` : 'p'}-first`
      document.getElementById(target)?.focus({ preventScroll: true })
    },
    onRestore: (s) => {
      setMessage(null)
      setRemoving(null)
      setStep(s.step)
      setAt(s.at)
    },
  })

  // A refusal landed on a card, whose step is on screen now: focus its first invalid field.
  useEffect(() => {
    const key = errorFocus.current
    if (!key || step !== 'form') return
    errorFocus.current = null
    focusCardError(key)
  }, [draft, errors, step, at])

  if (!competition || !row) {
    return (
      <div className="flex flex-col gap-4" data-testid="competition-unavailable">
        <PageTop back={backTo ? { to: backTo, label: 'Konkurencje' } : null} right={model.title} />
        <p className="text-lg text-apex-text-bright">Ta konkurencja nie przyjmuje zapisów.</p>
      </div>
    )
  }

  const today = warsawToday()
  const variants = cardVariants(draft, today)
  const open = row.state === 'open'
  const paid = raw.pricingMode !== 'free'
  const email = claimedEmail(draft).trim()
  const codeNeeded = needsCode(user?.email, email, verifiedEmail)
  const ready = draftReady(draft, { consents, accepted, serviceAccepted })
  const people = peopleCount(draft)
  const first = draft.cards[0].person
  const dataInfo = runnerDataInfo({
    eventName: model.title, organizerName: model.organizerName, contactEmail: model.contactEmail,
    paid: raw.pricingMode !== 'free', teams: raw.competitions.some((c) => c.kind === 'team'),
    nationality: fields.nationality !== 'off',
  })
  const compOf = (id) => raw.competitions.find((c) => c.categoryId === id)
  const rowOf = (id) => model.competitions.find((c) => c.categoryId === id)
  const groupOf = (i) => {
    const c = draft.cards[i]
    const p = effectivePerson(draft, i, today)
    const comp = compOf(c.categoryId)
    return (variants[i] === 'minor' && kidsGroupLabel(p, comp)) || categoryPreview(p, contexts.get(c.categoryId))
  }

  const clearErrors = (key, names) => setErrors((e) => {
    if (!e[key]) return e
    const next = { ...e[key] }
    for (const n of names) delete next[n]
    return { ...e, [key]: next }
  })

  const change = (key, index) => (patch) => {
    if (index === 0) for (const k of Object.keys(patch)) touched.current.add(k)
    setDraft((d) => updatePerson(d, key, patch))
    clearErrors(key, Object.keys(patch))
  }

  const showErrors = (errs, focus = erroredCards(draft, errs)[0] ?? null) => {
    setErrors(errs)
    errorFocus.current = focus
    // A refused person's step replaces whatever was on screen.
    if (focus) setAt(focus)
  }

  const fail = (err) => {
    const f = groupFailure(err, draft, today)
    // The server wants a code again (the session is gone): the earlier verification no longer counts.
    if (f.step === 'code') setVerifiedEmail(null)
    if (f.step === 'code' && !sentTo) {
      // The session ended between page load and submit: no code was ever sent.
      // Stay on the form and send one now.
      if (email) return startCode(email)
      setStep('form')
      setMessage(f.code)
      return undefined
    }
    setStep(f.step)
    setMessage(f.message)
    if (f.step === 'code') setCodeError(f.code)
    else showErrors(f.errors, f.focus)
    return undefined
  }

  async function register(withCode) {
    setBusy(true)
    try {
      await callFunction('register-free', toRequest(draft, { consents, code: withCode, today }))
      // register-free set the session cookie: drop whatever the browser cached about the previous visitor.
      clearAuthCache()
      clearFavoritesCache()
      clearNotificationsCache()
      forgetPublicRegistrationEvent(raw.slug)
      // Spec 14.17: the account register-free just opened skips onboarding here, and only here.
      navigate(afterRegistrationPath({ slug: raw.slug, hasUsername: !!user?.username }), { replace: true })
    } catch (err) {
      setBusy(false)
      await fail(err)
    }
  }

  function toSummary() {
    setMessage(null)
    setErrors({})
    setStep('summary')
  }

  // Paid events: the code opens the session here (the same verification register-free
  // and create-order use), and every refusal stays on the code step.
  async function verifyThenSummary() {
    setBusy(true)
    try {
      await verifyCode(sentTo ?? email, code)
      setVerifiedEmail(sentTo ?? email)
      clearAuthCache()
      clearFavoritesCache()
      clearNotificationsCache()
      toSummary()
    } catch (err) {
      if (err.code === 'email_retired') {
        const errs = { [draft.cards[0].key]: { email: err.message } }
        setStep('form')
        setMessage(fixMessage(draft, errs))
        showErrors(errs)
        return
      }
      setCodeError(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  async function sendCode(address) {
    await requestCode(address, honeypot, formPath(raw.slug, categoryId))
  }

  /** The draft as the server would judge it; false (and the errors shown) when it would refuse. */
  function checked() {
    const r = checkDraft(draft, { contexts, now: new Date() })
    if (r.ok) return true
    showErrors(r.errors)
    setMessage(r.groupError ?? fixMessage(draft, r.errors) ?? 'Popraw zaznaczone pola.')
    return false
  }

  async function onSubmitForm(e) {
    e.preventDefault()
    // On a person's step „Dodaj” (or Enter in a field) ends that step; the request starts on the list.
    if (view.kind === 'person') { if (!busy) finishCard(draft.cards[view.index].key); return undefined }
    if (preview || busy || !ready) return undefined
    setMessage(null)
    if (!checked()) return undefined
    // The session check may still be on its way: `user` is null then, which is not „signed out”.
    let needCode = codeNeeded
    if (authLoading) {
      setBusy(true)
      const resolved = await resolveUser()
      setBusy(false)
      needCode = needsCode(resolved?.email, email, verifiedEmail)
    }
    if (!needCode) return paid ? toSummary() : register(null)
    return startCode(email)
  }

  async function startCode(address) {
    setBusy(true)
    try {
      await sendCode(address)
      setSentTo(address)
      setCode('')
      setResent(false)
      setErrors({})
      setCodeError(null)
      setStep('code')
    } catch (err) {
      setStep('form')
      const f = groupFailure(err, draft, today)
      showErrors(f.errors, f.focus)
      setMessage(f.message)
    } finally {
      setBusy(false)
    }
  }

  async function onSubmitCode(e) {
    e.preventDefault()
    if (!checked()) { setStep('form'); return }
    if (paid) { await verifyThenSummary(); return }
    await register(code)
  }

  async function onResend() {
    setCodeError(null)
    if (!sentTo) { setStep('form'); return }
    try {
      await sendCode(sentTo)
      setResent(true)
    } catch (err) {
      fail(err)
    }
  }

  function go(to) {
    setMessage(null)
    setAt(to)
  }

  /** The list's „+ Zapisz kolejną osobę”: nobody to check on the way. */
  function addPersonStep() {
    const next = addPerson(draft, { categoryId })
    setDraft(next)
    go(next.cards[next.cards.length - 1].key)
  }

  // Leaves a person forward, once the server would accept them. `add` opens a new person's step:
  // 'person' („+ Zapisz kolejną osobę”) or 'child' („+ Kolejne dziecko”, same competition and
  // surname); without it („Dodaj · N osoby”) the next step is `stepAfter`'s.
  function finishCard(key, add = null) {
    const own = checkDraft(draft, { contexts, now: new Date() }).errors[key]
    if (own && Object.keys(own).length) {
      setErrors((e) => ({ ...e, [key]: own }))
      errorFocus.current = key
      return
    }
    const finished = setCardOpen(draft, key, false)
    const next = add ? addPerson(finished, add === 'child' ? { after: key } : { categoryId }) : finished
    setDraft(next)
    go(add ? next.cards[next.cards.length - 1].key : stepAfter(next, key, errors))
  }

  // „Nie startuję”: it needs a card for somebody else, and goes straight there unless the payer
  // still has to give their own name and address, which only this card asks for. Off, that card
  // goes while still empty.
  function toggleNotRunning(on) {
    const next = setNotRunning(draft, on)
    setDraft(next)
    if (!on || !next.autoCard) return setAt(draft.cards[0].key)
    const payerDone = !checkDraft(next, { contexts, now: new Date() }).errors[next.cards[0].key]
    return setAt(payerDone ? next.autoCard : next.cards[0].key)
  }

  // „Usuń”: an empty card goes at once; one holding anything asks „Usunąć tę osobę?” first.
  function askRemove(c) {
    if (cardEmpty(c)) return confirmRemove(c.key)
    return setRemoving(c.key)
  }
  function confirmRemove(key) {
    setRemoving(null)
    setDraft((d) => removePerson(d, key))
    setErrors((e) => { const { [key]: _gone, ...rest } = e; return rest })
    go(LIST_STEP)
    // The row that had the focus is gone.
    requestAnimationFrame(() => document.getElementById('group-list-heading')?.focus({ preventScroll: true }))
  }
  function cancelRemove(n) {
    setRemoving(null)
    requestAnimationFrame(() => document.getElementById(`p${n}-remove`)?.focus())
  }

  // An in-page link away (the back link, „Zaloguj się”) would drop the group too: beforeunload
  // never sees it, so it asks here.
  function onLinkAway(e) {
    if (!guard) return
    const a = e.target.closest?.('a[href]')
    if (!a || a.target === '_blank' || a.origin !== window.location.origin) return
    if (!confirmLeave()) { e.preventDefault(); e.stopPropagation() }
  }

  // The competitions of everybody the request registers, for the banner on top.
  const groupRows = [...new Set(draft.cards.filter((_, i) => i > 0 || !draft.notRunning).map((c) => c.categoryId))]
    .map(rowOf).filter(Boolean)

  if (step === 'summary' && !preview) {
    const lines = draft.cards.flatMap((c, i) => {
      if (i === 0 && draft.notRunning) return []
      const p = effectivePerson(draft, i, today)
      return [{
        key: c.key, categoryId: c.categoryId, name: `${p.firstName} ${p.lastName}`, competitionName: rowOf(c.categoryId)?.name ?? '',
        ageGroupLabel: groupOf(i), priceGrosze: priceOf[c.categoryId] ?? compOf(c.categoryId)?.priceGrosze ?? 0,
      }]
    })
    return (
      <Podsumowanie raw={raw} open={open} lines={lines} body={toRequest(draft, { consents, today })}
        addedCategoryIds={draft.cards.slice(1).map((c) => c.categoryId)}
        onRepriced={(byCategory) => setPriceOf((m) => ({ ...m, ...byCategory }))}
        onBack={() => setStep('form')} onFailure={(err) => fail(err)} />
    )
  }

  if (step === 'code' && sentTo) {
    return (
      <div className="flex flex-col gap-4">
        <PageTop right="KROK 2/3" />
        <CodeStep email={sentTo} code={code} onCode={setCode} error={codeError} busy={busy} resent={resent}
          submitLabel={paid ? 'Dalej' : 'Zapisz się'}
          onSubmit={onSubmitCode} onResend={onResend} onChangeAddress={() => { setStep('form'); setCodeError(null); setAt(draft.cards[0].key) }} />
      </div>
    )
  }

  const personForm = (c, i) => {
    const variant = variants[i]
    return (
      <PersonForm fields={fields} value={effectivePerson(draft, i, today)} onChange={change(c.key, i)} errors={errors[c.key] ?? {}}
        competition={compOf(c.categoryId)} raceDate={contexts.get(c.categoryId)?.raceDate} reckoning={contexts.get(c.categoryId)?.reckoning}
        ageGroups={contexts.get(c.categoryId)?.ageGroups ?? []} disabled={busy} variant={variant} idPrefix={i === 0 ? 'p' : `p${i + 1}`}
        {...(i === 0 ? {
          prefill: authLoading ? {} : prefill,
          loginHref: `/login?from=${encodeURIComponent(formPath(raw.slug, categoryId))}`,
          codeNote: codeNeeded ? 'Wyślemy na niego kod potwierdzający zapis.' : 'Jesteś zalogowany na ten adres — bez kodu.',
          notRunning: draft.notRunning,
          onNotRunning: toggleNotRunning,
        } : {
          prefill: null,
          codeNote: variant === 'adult' ? ADULT_NOTE : undefined,
          guardian: {
            name: [first.firstName, first.lastName].filter(Boolean).join(' '), email: first.email,
            checked: c.guardianConsent, onChange: (v) => { setDraft((d) => setGuardianConsent(d, c.key, v)); clearErrors(c.key, ['guardianConsent']) },
          },
        })} />
    )
  }

  const firstCard = <div data-card-key={draft.cards[0].key} tabIndex={-1} className="outline-none">{personForm(draft.cards[0], 0)}</div>

  // The one person of a person's step, past card 1: their competition, their form, the way on.
  const personStep = (c, i) => {
    const n = i + 1
    const minor = variants[i] === 'minor'
    const compError = errors[c.key]?.competition
    return (
      <section key={c.key} className="border border-apex-border-mid p-3.5 flex flex-col gap-[18px] outline-none" data-testid="person-card"
        data-variant={variants[i]} data-card-key={c.key} tabIndex={-1} aria-labelledby={`p${n}-heading`}>
        <div className="flex justify-between items-center gap-3">
          <h2 id={`p${n}-heading`} className="font-display font-extrabold text-xl uppercase text-apex-text-bright">Osoba {n}</h2>
          {removing !== c.key && (
            <button type="button" id={`p${n}-remove`} onClick={() => askRemove(c)} disabled={busy} className={removeBtn}
              aria-label={`Usuń — ${cardName(draft, i)}`}>Usuń</button>
          )}
        </div>
        {removing === c.key && (
          <RemoveConfirm id={`p${n}-remove-q`} name={cardName(draft, i)}
            onYes={() => confirmRemove(c.key)} onNo={() => cancelRemove(n)} />
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`p${n}-competition`} className={labelCls}>Konkurencja</label>
          <select id={`p${n}-competition`} className={`${inputCls} ${compError ? 'border-apex-red' : ''}`} value={c.categoryId} disabled={busy}
            aria-invalid={compError ? 'true' : undefined} aria-describedby={compError ? `p${n}-competition-error` : undefined}
            onChange={(e) => { setDraft((d) => setCardCompetition(d, c.key, e.target.value)); clearErrors(c.key, ['competition']) }}>
            {choices.map((k) => <option key={k.categoryId} value={k.categoryId}>{k.name} · {k.priceLabel}</option>)}
          </select>
          {compError && <p id={`p${n}-competition-error`} className="text-apex-red font-sans text-sm">{compError}</p>}
        </div>
        {personForm(c, i)}
        <div className="flex flex-col gap-2">
          <button type="submit" disabled={busy} className={primaryBtn} data-testid="person-done">
            {c.open ? 'Dodaj' : 'Gotowe'} · {countPl(people, ['osoba', 'osoby', 'osób'])}
          </button>
          {minor
            ? <button type="button" onClick={() => finishCard(c.key, 'child')} disabled={busy || !canAdd(draft)}
                className={`${secondaryBtn} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="next-child">+ Kolejne dziecko</button>
            : <button type="button" onClick={() => finishCard(c.key, 'person')} disabled={busy || !canAdd(draft)}
                className={`${secondaryBtn} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="add-person">+ Zapisz kolejną osobę</button>}
        </div>
      </section>
    )
  }

  const onPerson = view.kind === 'person'
  // Card 1 as a step of a group: on to person 2 when they are still to be filled in, or back to the list.
  const afterFirst = onPerson && view.index === 0 ? stepAfter(draft, draft.cards[0].key, errors) : null
  const afterFirstIndex = draft.cards.findIndex((c) => c.key === afterFirst)
  // The banner: an added person's step has its own competition select; the one on top would be somebody else's.
  const bannerRows = onPerson && view.index > 0 ? []
    : onPerson && !draft.notRunning ? [rowOf(draft.cards[0].categoryId)].filter(Boolean)
      : groupRows.length ? groupRows : [row]
  const errorLine = message && <p className="text-apex-red text-base" role="alert" data-testid="form-error">{message}</p>
  // A person's step is taller than a screen: the line stays under the navbar while the field is in view.
  const stepError = message && <div className="sticky top-14 z-10 bg-apex-bg py-2">{errorLine}</div>

  return (
    <form onSubmit={onSubmitForm} onClickCapture={onLinkAway} noValidate className="flex flex-col gap-[18px]" data-testid="registration-form">
      <PageTop back={backTo ? { to: backTo, label: 'Konkurencje' } : null} right="KROK 1/3" />
      {onPerson && (
        <button type="button" onClick={() => go(LIST_STEP)} disabled={busy} data-testid="group-link"
          className="self-start min-h-11 font-sans font-bold text-base text-apex-yellow whitespace-nowrap hover:text-apex-yellow-bright">
          Osoby w zgłoszeniu: {people} →
        </button>
      )}
      {bannerRows.length > 0 && (
        <div className="border border-apex-yellow px-3.5 py-3 flex flex-col gap-1" data-testid="group-competitions">
          {bannerRows.map((r) => (
            <div key={r.categoryId} className="flex justify-between items-center gap-3">
              <span className="text-lg font-bold text-apex-text-bright">{r.name}</span>
              <span className="font-mono text-apex-yellow whitespace-nowrap">{r.priceLabel}</span>
            </div>
          ))}
        </div>
      )}
      {!open && !preview && <p className="text-apex-red text-base">Zapisy na tę konkurencję są zamknięte.</p>}

      {/* Honeypot, as on the login form: hidden from people, filled by bots. */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>

      {onPerson && stepError}
      {view.kind === 'single' && firstCard}
      {onPerson && view.index > 0 && personStep(draft.cards[view.index], view.index)}
      {onPerson && view.index === 0 && (
        <>
          {firstCard}
          <button type="submit" disabled={busy} className={primaryBtn} data-testid="person-done">
            {afterFirstIndex > 0 ? `Dalej · osoba ${afterFirstIndex + 1}` : `Gotowe · ${countPl(people, ['osoba', 'osoby', 'osób'])}`}
          </button>
        </>
      )}

      {view.kind === 'list' && (
        <div className="flex flex-col gap-3" data-testid="group-list">
          <h2 id="group-list-heading" tabIndex={-1} className={`${sectionCls} outline-none`}>Osoby w zgłoszeniu: {people}</h2>
          <ul className="flex flex-col gap-2">
            {draft.cards.map((c, i) => {
              const n = i + 1
              const buyerRow = i === 0 && draft.notRunning
              return (
                <PersonRow key={c.key} cardKey={c.key} n={n} person={effectivePerson(draft, i, today)} disabled={busy}
                  label={buyerRow ? 'Ty · nie startujesz' : i === 0 ? 'Osoba 1 · Ty' : `Osoba ${n}`}
                  detail={buyerRow ? first.email : [rowOf(c.categoryId)?.name, groupOf(i)].filter(Boolean).join(' · ')}
                  onEdit={() => go(c.key)} onRemove={i > 0 ? () => askRemove(c) : null} confirming={removing === c.key}
                  onConfirm={() => confirmRemove(c.key)} onCancel={() => cancelRemove(n)} />
              )
            })}
          </ul>
        </div>
      )}

      {!onPerson && (
        <>
          <button type="button" onClick={() => (view.kind === 'single' ? finishCard(draft.cards[0].key, 'person') : addPersonStep())}
            disabled={busy || !canAdd(draft)} className={`${secondaryBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
            data-testid="add-person">
            + Zapisz kolejną osobę
          </button>

          <ConsentList consents={consents} accepted={accepted} onToggle={(id, v) => setAccepted((a) => ({ ...a, [id]: v }))}
            serviceAccepted={serviceAccepted} onService={setServiceAccepted} regulaminUrl={model.regulaminUrl} dataInfo={dataInfo} />

          {errorLine}
          <button type="submit" data-testid="registration-submit" disabled={preview || busy || !ready || !open} className={primaryBtn}>
            {busy ? 'Chwileczkę…' : codeNeeded || paid ? 'Dalej' : 'Zapisz się'}
          </button>
        </>
      )}
    </form>
  )
}

/** A team competition has its own flow (RB1–RB3); every other one is the person form. */
export function ZapisView(props) {
  const { raw, categoryId } = props
  const competition = raw.competitions.find((c) => c.categoryId === categoryId)
  return competition?.kind === 'team' ? <TeamSignup {...props} /> : <PersonSignup {...props} />
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
