import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useAuth, { clearAuthCache, resolveUser } from '../../hooks/useAuth.js'
import { clearFavoritesCache } from '../../hooks/useFavorites.js'
import { clearNotificationsCache } from '../../hooks/useNotifications.js'
import { forgetPublicRegistrationEvent, reloadPublicRegistrationEvent } from '../../hooks/usePublicRegistrationEvent.js'
import { callFunction, requestCode, verifyCode } from '../../lib/auth.js'
import { afterRegistrationPath } from '../../lib/inviteLink.js'
import { eventPageModel } from '../../lib/eventPageModel.js'
import {
  profilePrefill, mergePrefill, fieldModes, needsCode, categoryPreview, consentsComplete, kidsGroupLabel,
} from '../../lib/personFormModel.js'
import {
  updatePerson, setCardOpen, setGuardianConsent, cardVariants, effectivePerson, cardEmpty, cardName, claimedEmail,
  erroredCards, fixMessage, formStep, LIST_STEP, setCardVoucher, setCardExtra, draftOrdersExtras, draftConsents,
} from '../../lib/groupDraft.js'
import { donationsOffered, orderableExtras, pickedExtras } from '../../lib/cartModel.js'
import { checkVoucherCode } from '../../lib/voucherCheck.js'
import { discountedPrice, voucherLineLabel } from '@registration/pricing.js'
import { normalizeCode } from '@registration/vouchers.js'
import {
  ADULT_EMAIL_NOTE, initTeam, setSize, droppedBy, moveMember, removeMember, squadCards, toTeamRequest, teamContext, checkTeam, checkCaptain,
  firstOpenMember, memberAfter, memberAgeLabel, teamFailure, repricedFee,
} from '../../lib/teamDraft.js'
import { useLeaveGuard, confirmLeave } from '../../lib/leaveGuard.js'
import { focusCardError, useStepHistory } from '../../lib/useStepHistory.js'
import { useMoveFocus } from '../../lib/useMoveFocus.jsx'
import { warsawToday } from '@registration/dates.js'
import { MIN_TEAM_SIZE } from '@registration/flags.js'
import { TEAM_NAME_MAX } from '@registration/team.js'
import { requiredConsents } from '@registration/consents.js'
import { runnerDataInfo } from '../../legal/runnerDataInfo.js'
import CodeStep from '../../components/registration/CodeStep.jsx'
import ConsentList from '../../components/registration/ConsentList.jsx'
import PageTop from '../../components/registration/PageTop.jsx'
import PersonForm from '../../components/registration/PersonForm.jsx'
import { MoveButtons, PersonRow, RemoveConfirm } from '../../components/registration/PersonRow.jsx'
import { inputCls, labelCls, primaryBtn, removeBtn, secondaryBtn, sectionCls } from '../../components/registration/ui.js'
import Podsumowanie, { orderPath } from './Podsumowanie.jsx'
import { formPath } from './RegistrationEventPage.jsx'

// A team's sign-up, on its own flow: RB1 captain → RB2 squad → RB3 payment. RB1 asks for the team's
// name, its size, the captain and the consents. The e-mail code is checked when RB1 is left, so
// RB2 and RB3 run on the captain's own session and „Wróć” / „Dalej” send no second code (D5-26).
// RB2 shows one member at a time, like the group form, and the list step („Skład”) changes, removes,
// adds and, with leg order on, reorders them. A paid team goes on to RB3 (Podsumowanie with `team`);
// a free team, or a 0 zł fee, is registered from the list. The draft is in memory only (teamDraft.js),
// and once RB1 is left the page asks before it is closed. `preview` (organizer „Podgląd jako
// zawodnik”) renders RB1 with the way on disabled.
//
// Plan 7 (task 8a fix round): RB1 takes the team line's one discount code (on the captain's step,
// kept on the captain's card, checked by check-voucher when RB1 is left; a 429 or no connection
// leaves it to register-team), and each member's step its extras. RB3's fee line goes through
// checkoutCart with the code and every member's extras, which RB3 lists under each member. The
// team goes through RB3 whenever it can cost money (a fee, an extra, or a charity event's chips);
// a total that stays 0 on a free team registers from there.

const stepTitle = (legOrder, n) => (legOrder ? `Zmiana ${n}` : `Osoba ${n}`)

export default function TeamSignup({ raw: rawProp, categoryId, preview = false, backTo }) {
  // The snapshot read again after the server said it is stale (a sold-out extra; review M-1).
  const [freshRaw, setFreshRaw] = useState(null)
  const raw = freshRaw ?? rawProp
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const model = useMemo(() => eventPageModel(raw), [raw])
  const competition = raw.competitions.find((c) => c.categoryId === categoryId)
  const row = model.competitions.find((c) => c.categoryId === categoryId)
  const context = useMemo(() => teamContext(raw, competition), [raw, competition])
  const fields = fieldModes(raw.formFields)
  const consents = raw.consents ?? []
  // RB1's boxes are the captain's own: a minors-only consent (the guardian's) waits for RB2, where
  // it shows only while a child is in the squad (guardianConsents below).
  const captainConsents = requiredConsents(consents)
  const legOrder = competition.legOrderEnabled === true
  const teamMin = Math.max(competition.teamMin ?? MIN_TEAM_SIZE, MIN_TEAM_SIZE)
  const teamMax = Math.max(competition.teamMax ?? teamMin, teamMin)

  // 'captain' (RB1), 'code', 'squad' (RB2; `at` says which of its steps) or 'payment' (RB3).
  const [step, setStep] = useState('captain')
  const [at, setAt] = useState(LIST_STEP)
  const [draft, setDraft] = useState(() => initTeam(teamMin, categoryId))
  const [errors, setErrors] = useState({})
  const [nameError, setNameError] = useState(null)
  const [message, setMessage] = useState(null)
  const [codeError, setCodeError] = useState(null)
  const [accepted, setAccepted] = useState({})
  const [serviceAccepted, setServiceAccepted] = useState(false)
  const [honeypot, setHoneypot] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState(null)
  const [resent, setResent] = useState(false)
  const [busy, setBusy] = useState(false)
  // The fee after a price_changed: a trip back to RB2 and on to RB3 shows the server's.
  const [fee, setFee] = useState(null)
  const [verifiedEmail, setVerifiedEmail] = useState(null)
  // check-voucher's note on a team code it could not judge (429, no connection).
  const [voucherNote, setVoucherNote] = useState(null)
  // RB1 has been left: from here on closing the tab loses a squad.
  const [leftCaptain, setLeftCaptain] = useState(false)
  // The card asking „Usunąć tę osobę?”, and the smaller size asking „Usunąć z drużyny: …?” on RB1.
  const [removing, setRemoving] = useState(null)
  const [shrinkTo, setShrinkTo] = useState(null)
  // Fields of the captain's card the person typed into: the profile never overwrites them.
  const touched = useRef(new Set())
  // The card whose first invalid field takes the focus once the errors are on screen.
  const errorFocus = useRef(null)
  const moves = useMoveFocus()

  const prefill = useMemo(() => (user ? profilePrefill(user) : null), [user])
  useEffect(() => {
    if (!prefill) return
    setDraft((d) => {
      const first = d.cards[0]
      return { ...d, cards: [{ ...first, person: mergePrefill(first.person, prefill, touched.current) }, ...d.cards.slice(1)] }
    })
  }, [prefill])

  const guard = leftCaptain && !preview
  useLeaveGuard(guard)

  const view = formStep(draft, at)
  const onMember = step === 'squad' && view.kind === 'person' && view.index > 0
  const stepId = step === 'squad' ? (onMember ? draft.cards[view.index].key : LIST_STEP) : step

  useStepHistory({
    id: stepId,
    state: { step, at },
    guard,
    onEnter: () => {
      if (errorFocus.current) return
      window.scrollTo({ top: 0, behavior: 'instant' })
      const target = step === 'captain' ? 'team-name' : onMember ? `p${view.index + 1}-first` : step === 'squad' ? 'squad-heading' : null
      if (target) document.getElementById(target)?.focus({ preventScroll: true })
    },
    onRestore: (s) => {
      setMessage(null)
      setRemoving(null)
      setShrinkTo(null)
      setStep(s.step)
      setAt(s.at)
    },
  })

  useEffect(() => {
    const key = errorFocus.current
    if (!key || (step !== 'captain' && step !== 'squad')) return
    errorFocus.current = null
    focusCardError(key)
  }, [draft, errors, nameError, step, at])

  const today = warsawToday()
  const variants = cardVariants(draft, today)
  const guardianConsents = draftConsents(draft, consents, today).filter((c) => !captainConsents.includes(c))
  const guardianReady = consentsComplete(guardianConsents, accepted, true)
  const open = row?.state === 'open'
  const priceGrosze = fee ?? competition.priceGrosze ?? 0
  const feePaid = raw.pricingMode !== 'free' && priceGrosze !== 0
  // What each member orders, of what the page still offers: RB3 shows it and the request carries it.
  const picksOf = (c) => pickedExtras(c.extras, orderableExtras(raw.extras, categoryId))
  const extrasOf = (c) => picksOf(c).map((x) => ({ variantId: x.variantId, qty: x.qty }))
  const ordersExtras = draftOrdersExtras(draft, extrasOf)
  // Through RB3 when the team can cost money (Plan 7).
  const paid = feePaid || ordersExtras || donationsOffered(raw)
  const email = claimedEmail(draft).trim()
  const codeNeeded = needsCode(user?.email, email, verifiedEmail)
  const captainKey = draft.cards[0].key
  const members = draft.cards.length
  const dataInfo = runnerDataInfo({
    eventName: model.title, organizerName: model.organizerName, contactEmail: model.contactEmail,
    paid: raw.pricingMode !== 'free', teams: true, nationality: fields.nationality !== 'off',
  })

  const groupOf = (i) => {
    const p = effectivePerson(draft, i, today)
    return (variants[i] === 'minor' && kidsGroupLabel(p, competition)) || categoryPreview(p, context)
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

  function go(to) {
    setMessage(null)
    setRemoving(null)
    setAt(to)
  }

  function toCaptain() {
    setMessage(null)
    setRemoving(null)
    setStep('captain')
  }

  function enterSquad() {
    setMessage(null)
    setLeftCaptain(true)
    setAt(firstOpenMember(draft))
    setStep('squad')
  }

  /** A refusal, shown where it belongs: `to` is 'captain' or 'squad', `focus` a card or null. */
  function show({ to, errors: errs, nameError: name = null, message: text = null, focus = null }) {
    setErrors(errs)
    setNameError(name)
    setMessage(text)
    errorFocus.current = to === 'captain' ? captainKey : focus
    setStep(to)
    if (to === 'squad') setAt(focus ?? LIST_STEP)
  }

  function fail(err) {
    // A sold-out or withdrawn extra: the page's copy of the stock is stale (M-1).
    if (err?.field === 'extras') {
      reloadPublicRegistrationEvent(raw.slug).then((r) => { if (r.status === 'ok') setFreshRaw(r.raw) })
    }
    // The team code register-team refused is no longer accepted.
    if (err?.field === 'voucherCode') setDraft((d) => setCardVoucher(d, captainKey, { state: 'error' }))
    const f = teamFailure(err, draft, today)
    if (f.step === 'code') {
      // The session is gone: the earlier verification no longer counts.
      setVerifiedEmail(null)
      return startCode(email)
    }
    show({ to: f.step, errors: f.errors, nameError: f.nameError, message: f.message, focus: f.focus })
    return undefined
  }

  async function startCode(address) {
    setBusy(true)
    try {
      await requestCode(address, honeypot, formPath(raw.slug, categoryId))
      setSentTo(address)
      setCode('')
      setResent(false)
      setErrors({})
      setCodeError(null)
      setStep('code')
    } catch (err) {
      const f = teamFailure(err, draft, today)
      show({ to: 'captain', errors: f.errors, nameError: f.nameError, message: f.message })
    } finally {
      setBusy(false)
    }
  }

  /**
   * The team code, checked by check-voucher. → { ok, error }. A 429 or no connection leaves it
   * unchecked with a note and does not hold RB1 (register-team decides; review I-1).
   */
  async function checkTeamCode() {
    const code = (draft.cards[0].voucher?.code ?? '').trim()
    if (!code) return { ok: true }
    const same = (d) => d.cards[0].voucher.code.trim() === code
    setDraft((d) => (same(d) ? setCardVoucher(d, captainKey, { state: 'checking' }) : d))
    setVoucherNote(null)
    const r = await checkVoucherCode({ slug: raw.slug, categoryId, code })
    if (r.state === 'ok') {
      setDraft((d) => (same(d) ? setCardVoucher(d, captainKey, { state: 'ok', percent: r.percent, price: r.price }) : d))
      clearErrors(captainKey, ['voucherCode'])
      return { ok: true }
    }
    if (r.state === 'unchecked') {
      setDraft((d) => (same(d) ? setCardVoucher(d, captainKey, { state: 'idle' }) : d))
      clearErrors(captainKey, ['voucherCode'])
      setVoucherNote(r.note)
      return { ok: true }
    }
    setDraft((d) => (same(d) ? setCardVoucher(d, captainKey, { state: 'error' }) : d))
    setErrors((e) => ({ ...e, [captainKey]: { ...(e[captainKey] ?? {}), voucherCode: r.error } }))
    return { ok: false, error: r.error }
  }

  async function leaveCaptain() {
    if (preview || busy || !open || !consentsComplete(captainConsents, accepted, serviceAccepted)) return undefined
    setMessage(null)
    const v = draft.cards[0].voucher
    if (v.code.trim() && v.state !== 'ok') {
      setBusy(true)
      const checked = await checkTeamCode()
      setBusy(false)
      if (!checked.ok) {
        errorFocus.current = captainKey
        return undefined
      }
    }
    const r = checkCaptain(draft, { context, now: new Date() })
    if (!r.ok) {
      show({ to: 'captain', errors: r.errors, nameError: r.nameError, message: r.groupError ?? 'Popraw zaznaczone pola.' })
      return undefined
    }
    setErrors({})
    setNameError(null)
    // The session check may still be on its way: `user` is null then, which is not „signed out”.
    let needCode = codeNeeded
    if (authLoading) {
      setBusy(true)
      const resolved = await resolveUser()
      setBusy(false)
      needCode = needsCode(resolved?.email, email, verifiedEmail)
    }
    return needCode ? startCode(email) : enterSquad()
  }

  // RB1's way back to the squad is RB1's way forward: an edited captain is checked and, with a
  // changed address, verified. Boxes unticked meanwhile are said out loud.
  function backToSquad() {
    if (consentsComplete(captainConsents, accepted, serviceAccepted)) return leaveCaptain()
    setMessage('Zaznacz wymagane zgody, żeby wrócić do składu.')
    return undefined
  }

  async function onSubmitCode(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await verifyCode(sentTo ?? email, code)
      setVerifiedEmail(sentTo ?? email)
      clearAuthCache()
      clearFavoritesCache()
      clearNotificationsCache()
      enterSquad()
    } catch (err) {
      if (err.code === 'email_retired') {
        show({ to: 'captain', errors: { [captainKey]: { email: err.message } }, message: fixMessage(draft, { [captainKey]: { email: err.message } }) })
        return
      }
      setCodeError(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  async function onResend() {
    setCodeError(null)
    try {
      await requestCode(sentTo, honeypot, formPath(raw.slug, categoryId))
      setResent(true)
    } catch (err) {
      setCodeError(err.status == null ? 'Nie udało się połączyć. Spróbuj ponownie.' : err.message)
    }
  }

  // Leaves a member forward, once the server would accept them.
  function finishMember(key) {
    const own = checkTeam(draft, { context, now: new Date() }).errors[key]
    if (own && Object.keys(own).length) {
      setErrors((e) => ({ ...e, [key]: own }))
      errorFocus.current = key
      return
    }
    const finished = setCardOpen(draft, key, false)
    setDraft(finished)
    go(memberAfter(finished, key, errors))
  }

  function addMember() {
    const next = setSize(draft, members + 1)
    setDraft(next)
    go(next.cards[next.cards.length - 1].key)
  }

  function askRemove(c) {
    if (cardEmpty(c)) return confirmRemove(c.key)
    return setRemoving(c.key)
  }
  function confirmRemove(key) {
    setDraft((d) => removeMember(d, key))
    setErrors((e) => { const { [key]: _gone, ...rest } = e; return rest })
    go(LIST_STEP)
    requestAnimationFrame(() => document.getElementById('squad-heading')?.focus({ preventScroll: true }))
  }
  function cancelRemove(n) {
    setRemoving(null)
    requestAnimationFrame(() => document.getElementById(`p${n}-remove`)?.focus())
  }

  // RB1's size buttons: a smaller size that would drop somebody typed in asks first.
  function pickSize(n) {
    setShrinkTo(null)
    if (droppedBy(draft, n).every(cardEmpty)) setDraft((d) => setSize(d, n))
    else setShrinkTo(n)
  }

  function settled() {
    // register-team may have set the session cookie: drop what the browser cached.
    clearAuthCache()
    clearFavoritesCache()
    clearNotificationsCache()
    forgetPublicRegistrationEvent(raw.slug)
  }

  async function registerTeam() {
    setBusy(true)
    try {
      const r = await callFunction('register-team', toTeamRequest(draft, {
        consents, legOrder, displayedTotal: priceGrosze, today, website: honeypot, extrasOf,
      }))
      settled()
      // A 0 zł fee on a paid event has an order (D5-23). The honeypot's 200 carries no data.
      if (r.data?.orderId) navigate(orderPath(r.data.orderId), { replace: true })
      else navigate(afterRegistrationPath({ slug: raw.slug, hasUsername: !!user?.username }), { replace: true })
    } catch (err) {
      setBusy(false)
      if (err.code === 'pending_order' && err.orderId) {
        settled()
        navigate(orderPath(err.orderId), { replace: true })
        return
      }
      // A 0 zł fee that changed before „Zapisz”: keep the server's, or every retry sends 0 (L-1).
      const newFee = repricedFee(err)
      if (newFee != null) setFee(newFee)
      await fail(err)
    }
  }

  function submitSquad() {
    if (preview || busy || !open || !draft.membersConsent || !guardianReady) return undefined
    setMessage(null)
    const r = checkTeam(draft, { context, now: new Date() })
    if (!r.ok) {
      const first = erroredCards(draft, r.errors)[0] ?? null
      const toCaptainStep = first === captainKey || r.fieldErrors.teamName
      show({
        to: toCaptainStep ? 'captain' : 'squad', errors: r.errors, nameError: r.fieldErrors.teamName ?? null,
        message: r.groupError ?? fixMessage(draft, r.errors) ?? 'Popraw zaznaczone pola.', focus: first,
      })
      return undefined
    }
    if (paid) { setStep('payment'); return undefined }
    return registerTeam()
  }

  function onSubmit(e) {
    e.preventDefault()
    if (step === 'captain') return leaveCaptain()
    if (onMember) { if (!busy) finishMember(draft.cards[view.index].key); return undefined }
    return submitSquad()
  }

  // An in-page link away (the back link, „Zaloguj się”) would drop the squad: beforeunload never sees it.
  function onLinkAway(e) {
    if (!guard) return
    const a = e.target.closest?.('a[href]')
    if (!a || a.target === '_blank' || a.origin !== window.location.origin) return
    if (!confirmLeave()) { e.preventDefault(); e.stopPropagation() }
  }

  const personName = (i) => {
    const p = effectivePerson(draft, i, today)
    return `${p.firstName} ${p.lastName}`.trim()
  }
  const rowDetail = (i) => {
    if (i === 0) return [groupOf(0), 'KAPITAN ✓'].filter(Boolean).join(' · ')
    if (variants[i] === 'minor') {
      return [groupOf(i), memberAgeLabel(draft.cards[i].person, raw.eventDate, raw.ageReckoning ?? 'race_day'), 'OPIEKUN: KAPITAN'].filter(Boolean).join(' · ')
    }
    return groupOf(i) ?? ''
  }

  if (step === 'payment' && !preview) {
    const teamVoucher = draft.cards[0].voucher
    return (
      <Podsumowanie raw={raw} open={open} endpoint="register-team" stepLabel="KROK 3/3"
        body={toTeamRequest(draft, { consents, legOrder, today, website: honeypot, extrasOf })}
        team={{
          name: draft.teamName.trim(),
          members: squadCards(draft).map(({ card, index }) => ({ key: card.key, name: personName(index), detail: rowDetail(index), extras: picksOf(card) })),
        }}
        lines={[{
          key: 'fee', categoryId, name: `${row?.name ?? competition.name} · drużyna ${members}-osobowa`, priceGrosze,
          hasCode: teamVoucher.code.trim() !== '',
          voucher: teamVoucher.state === 'ok' && priceGrosze > 0
            ? { code: normalizeCode(teamVoucher.code) ?? teamVoucher.code.trim(), percent: teamVoucher.percent } : null,
          extras: draft.cards.flatMap(picksOf),
        }]}
        donation={donationsOffered(raw) ? { goal: raw.charityGoal ?? null } : null}
        onRegisterFree={!feePaid && !ordersExtras ? () => registerTeam() : null}
        // Absent (a coded fee is never fed back, N-1): the current fee stays (N-2).
        onRepriced={(byCategory) => { if (categoryId in byCategory) setFee(byCategory[categoryId]) }}
        onBack={() => { setMessage(null); setStep('squad'); setAt(LIST_STEP) }} onFailure={fail} />
    )
  }

  if (step === 'code' && sentTo) {
    return (
      <div className="flex flex-col gap-4">
        <PageTop right="KROK 1/3" />
        <CodeStep email={sentTo} code={code} onCode={setCode} error={codeError} busy={busy} resent={resent} submitLabel="Dalej"
          onSubmit={onSubmitCode} onResend={onResend} onChangeAddress={() => { setCodeError(null); setStep('captain') }} />
      </div>
    )
  }

  const errorLine = message && <p className="text-apex-red text-base" role="alert" data-testid="form-error">{message}</p>
  const priceLine = row?.priceLabel && (feePaid ? `${row.priceLabel} / drużyna` : row.priceLabel)
  // Plan 7: the team line's code on RB1 (a priced fee, or a code still held), and a member's extras.
  const offered = orderableExtras(raw.extras, categoryId)
  const extrasProps = (c) => (offered.length ? {
    extras: offered, picks: c.extras,
    onPick: (extraId, patch) => { setDraft((d) => setCardExtra(d, c.key, extraId, patch)); clearErrors(c.key, ['extras']) },
  } : null)
  const teamVoucher = draft.cards[0].voucher
  const voucherProps = priceGrosze > 0 || teamVoucher.code.trim() ? {
    value: teamVoucher,
    note: voucherNote,
    okLabel: teamVoucher.state === 'ok' && priceGrosze > 0
      ? voucherLineLabel({
        listPrice: priceGrosze, percent: teamVoucher.percent, code: normalizeCode(teamVoucher.code) ?? teamVoucher.code.trim(),
        price: discountedPrice(priceGrosze, teamVoucher.percent),
      })
      : null,
    onCode: (v) => { setDraft((d) => setCardVoucher(d, captainKey, { code: v })); clearErrors(captainKey, ['voucherCode']); setVoucherNote(null) },
    onCheck: () => { checkTeamCode() },
  } : null
  const banner = (
    <div className="border border-apex-yellow px-3.5 py-3 flex justify-between items-center gap-3" data-testid="group-competitions">
      <span className="text-lg font-bold text-apex-text-bright">{competition.name}</span>
      <span className="font-mono text-apex-yellow whitespace-nowrap">{priceLine}</span>
    </div>
  )
  // Hidden from people, filled by bots, as on the login form.
  const trap = (
    <div className="absolute -left-[9999px]" aria-hidden="true">
      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
    </div>
  )

  if (step === 'captain' || !leftCaptain) {
    const shrinking = shrinkTo == null ? [] : droppedBy(draft, shrinkTo)
    return (
      <form onSubmit={onSubmit} onClickCapture={onLinkAway} noValidate className="flex flex-col gap-[18px]" data-testid="team-captain">
        <PageTop back={backTo && !leftCaptain ? { to: backTo, label: 'Konkurencje' } : leftCaptain ? { label: 'Skład', onClick: backToSquad } : null} right="KROK 1/3" />
        {banner}
        {!open && !preview && <p className="text-apex-red text-base">Zapisy na tę konkurencję są zamknięte.</p>}
        {trap}
        <div className="flex flex-col gap-[18px] outline-none" data-card-key={captainKey} tabIndex={-1}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="team-name" className={labelCls}>Nazwa drużyny</label>
            <input id="team-name" className={`${inputCls} ${nameError ? 'border-apex-red' : ''}`} value={draft.teamName} maxLength={TEAM_NAME_MAX} autoComplete="off"
              aria-invalid={nameError ? 'true' : undefined} aria-describedby={nameError ? 'team-name-error team-name-note' : 'team-name-note'} disabled={busy}
              onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, teamName: v })); setNameError(null) }} />
            {nameError && <p id="team-name-error" className="text-apex-red font-sans text-sm">{nameError}</p>}
            <p id="team-name-note" className="font-sans text-sm text-apex-muted" data-testid="team-name-public">Nazwa drużyny będzie widoczna na publicznej liście startowej.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span id="team-size-label" className={labelCls}>Ile osób w składzie</span>
            <div className="grid grid-cols-5 gap-2" role="group" aria-labelledby="team-size-label" data-testid="team-size">
              {Array.from({ length: teamMax - teamMin + 1 }, (_, i) => teamMin + i).map((n) => (
                <button key={n} type="button" aria-pressed={members === n} disabled={busy} onClick={() => pickSize(n)}
                  className={`min-h-11 border font-mono text-[17px] whitespace-nowrap ${members === n
                    ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text bg-apex-surface'}`}>
                  {n}
                </button>
              ))}
            </div>
            {shrinking.length > 0 && (
              <RemoveConfirm id="team-size-q" question={`Usunąć z drużyny: ${shrinking.map((c) => c.person.firstName?.trim() || 'pusta osoba').join(', ')}?`}
                onYes={() => { setDraft((d) => setSize(d, shrinkTo)); setShrinkTo(null) }} onNo={() => setShrinkTo(null)} />
            )}
          </div>
          <PersonForm fields={fields} value={draft.cards[0].person} onChange={change(captainKey, 0)} errors={errors[captainKey] ?? {}}
            competition={competition} raceDate={context.raceDate} reckoning={context.reckoning} ageGroups={context.ageGroups} disabled={busy}
            variant="self" idPrefix="p" ownHeading="Kapitan" prefill={authLoading ? {} : prefill}
            loginHref={`/login?from=${encodeURIComponent(formPath(raw.slug, categoryId))}`}
            codeNote={codeNeeded ? 'Wyślemy na niego kod potwierdzający zapis.' : 'Jesteś zalogowany na ten adres — bez kodu.'}
            voucher={voucherProps} extras={extrasProps(draft.cards[0])} />
        </div>
        <ConsentList consents={captainConsents} accepted={accepted} onToggle={(id, v) => setAccepted((a) => ({ ...a, [id]: v }))}
          serviceAccepted={serviceAccepted} onService={setServiceAccepted} regulaminUrl={model.regulaminUrl} dataInfo={dataInfo} />
        {errorLine}
        <button type="submit" disabled={preview || busy || !open || !consentsComplete(captainConsents, accepted, serviceAccepted)} className={primaryBtn}>
          {busy ? 'Chwileczkę…' : 'Dalej: skład'}
        </button>
      </form>
    )
  }

  const memberStep = () => {
    const i = view.index
    const c = draft.cards[i]
    const n = i + 1
    const position = draft.order.indexOf(c.key) + 1
    const next = firstOpenAfter(draft, c.key)
    return (
      <section key={c.key} className="border border-apex-border-mid p-3.5 flex flex-col gap-[18px] outline-none" data-testid="member-card"
        data-variant={variants[i]} data-card-key={c.key} tabIndex={-1} aria-labelledby={`p${n}-heading`}>
        <div className="flex justify-between items-center gap-3">
          <h2 id={`p${n}-heading`} className="font-display font-extrabold text-xl uppercase text-apex-text-bright">{stepTitle(legOrder, position)}</h2>
          {removing !== c.key && members > teamMin && (
            <button type="button" id={`p${n}-remove`} onClick={() => askRemove(c)} disabled={busy} className={removeBtn}
              aria-label={`Usuń — ${cardName(draft, i)}`}>Usuń</button>
          )}
        </div>
        {removing === c.key && (
          <RemoveConfirm id={`p${n}-remove-q`} name={cardName(draft, i)}
            onYes={() => confirmRemove(c.key)} onNo={() => cancelRemove(n)} />
        )}
        <PersonForm fields={fields} value={effectivePerson(draft, i, today)} onChange={change(c.key, i)} errors={errors[c.key] ?? {}}
          competition={competition} raceDate={context.raceDate} reckoning={context.reckoning} ageGroups={context.ageGroups} disabled={busy}
          variant={variants[i]} idPrefix={`p${n}`} prefill={null} codeNote={variants[i] === 'adult' ? ADULT_EMAIL_NOTE : undefined}
          extras={extrasProps(c)}
          guardian={{
            name: cardName(draft, 0), email: draft.cards[0].person.email, checked: c.guardianConsent,
            onChange: (v) => { setDraft((d) => setGuardianConsent(d, c.key, v)); clearErrors(c.key, ['guardianConsent']) },
          }} />
        <button type="submit" disabled={busy} className={primaryBtn} data-testid="person-done">
          {next ? `Dalej · ${stepTitle(legOrder, draft.order.indexOf(next) + 1).toLowerCase()}` : 'Gotowe · skład'}
        </button>
      </section>
    )
  }

  return (
    <form onSubmit={onSubmit} onClickCapture={onLinkAway} noValidate className="flex flex-col gap-[18px]" data-testid="team-squad">
      <PageTop back={{ label: 'Drużyna', onClick: toCaptain }} right="KROK 2/3" />
      {trap}
      {onMember && (
        <button type="button" onClick={() => go(LIST_STEP)} disabled={busy} data-testid="squad-link"
          className="self-start min-h-11 font-sans font-bold text-base text-apex-yellow whitespace-nowrap hover:text-apex-yellow-bright">
          Skład: {members} →
        </button>
      )}
      {!open && !preview && <p className="text-apex-red text-base">Zapisy na tę konkurencję są zamknięte.</p>}
      {onMember && message && <div className="sticky top-14 z-10 bg-apex-bg py-2">{errorLine}</div>}
      {onMember && memberStep()}

      {!onMember && (
        <>
          <div className="flex flex-col gap-3" data-testid="squad-list">
            <h2 id="squad-heading" tabIndex={-1} className={`${sectionCls} outline-none`}>{legOrder ? 'Skład i kolejność' : 'Skład'}</h2>
            <ul className="flex flex-col gap-2">
              {squadCards(draft).map(({ card, index, leg }) => {
                const n = index + 1
                const name = personName(index) || `osoba ${n}`
                return (
                  <PersonRow key={card.key} cardKey={card.key} n={n} person={effectivePerson(draft, index, today)} disabled={busy}
                    label={stepTitle(legOrder, leg)} detail={rowDetail(index)}
                    onEdit={() => (index === 0 ? toCaptain() : go(card.key))} onRemove={index > 0 && members > teamMin ? () => askRemove(card) : null}
                    confirming={removing === card.key} onConfirm={() => confirmRemove(card.key)} onCancel={() => cancelRemove(n)}
                    lead={legOrder && (
                      <MoveButtons moveKey={card.key} name={name} place={leg} count={members} disabled={busy} onMove={(dir) => {
                        setDraft((d) => moveMember(d, leg - 1, leg - 1 + dir))
                        moves.moved(card.key, dir, `${name}: zmiana ${leg + dir}`)
                      }} />
                    )} />
                )
              })}
            </ul>
            {moves.status}
          </div>
          {members < teamMax && (
            <button type="button" onClick={addMember} disabled={busy} className={`${secondaryBtn} disabled:opacity-40 disabled:cursor-not-allowed`} data-testid="add-person">
              + Dodaj osobę
            </button>
          )}
          <label className="flex gap-3 items-start font-sans text-[15px] leading-snug text-apex-text cursor-pointer">
            <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0 accent-apex-yellow rounded-none" required checked={draft.membersConsent}
              onChange={(e) => { const v = e.target.checked; setDraft((d) => ({ ...d, membersConsent: v })) }} data-testid="members-consent" />
            <span><span className="text-apex-red" aria-hidden="true">*</span> Mam zgodę członków drużyny na podanie ich danych. Każdy dorosły dostanie mail z regulaminem do potwierdzenia.</span>
          </label>
          {guardianConsents.map((k) => (
            <label key={k.id} className="flex gap-3 items-start font-sans text-[15px] leading-snug text-apex-text cursor-pointer">
              <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0 accent-apex-yellow rounded-none" required checked={accepted[k.id] === true}
                onChange={(e) => { const v = e.target.checked; setAccepted((a) => ({ ...a, [k.id]: v })) }} data-testid="guardian-event-consent" />
              <span><span className="text-apex-red" aria-hidden="true">*</span> {k.text}</span>
            </label>
          ))}
          {errorLine}
          <button type="submit" disabled={preview || busy || !open || !draft.membersConsent || !guardianReady} className={primaryBtn} data-testid="squad-submit">
            {busy ? 'Chwileczkę…' : paid ? 'Dalej: płatność' : 'Zapisz drużynę'}
          </button>
        </>
      )}
    </form>
  )
}

/** The next member still to fill in after `key`, for the step's button, or null. */
function firstOpenAfter(draft, key) {
  const to = memberAfter(draft, key, {})
  return to === LIST_STEP ? null : to
}
