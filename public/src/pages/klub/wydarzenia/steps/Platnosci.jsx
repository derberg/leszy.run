import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { getClubPayout, getEventPayout, updateEventPayout } from '../../../../lib/organizer.js'
import { groupIban } from '../../../../lib/iban.js'
import { btnPrimary, errorClass, fieldInput, savedClass } from '../../settingsUi.js'
import { useKlub } from '../../context.js'
import { FieldError, InfoTip, Seg, cardClass, cardTitle, monoLabel, sectionErrors } from '../wizardUi.jsx'
import Vouchers from './Vouchers.jsx'

// A6: the payment window (24 h, 7 or 14 days, or „do końca zapisów”, with an ⓘ saying an unpaid
// entry expires and holds no place; the `payments` section: autosaved in a draft,
// staged after publish), the payout account, the package transfer (Plan 7: allowed or not and
// „Możliwe do”, at the latest the day before the race; part of `payments`, so every save sends the
// window and the transfer together, and a quick edit of one never drops the other), and the codes
// and partners (Vouchers.jsx, organizer-vouchers, applied at once). No transfer fee: ruling 1.
// The payout is not a section (ruling P3-R1): the club owner sets it through
// update-event-payout and it applies at once; an admin sees it masked
// (get-event-payout); a member never loads it.

// „do końca zapisów” is its own column (payment_window_until_close): the hours stay stored.
const UNTIL_CLOSE = 'close'
const WINDOWS = [[24, '24 godziny'], [168, '7 dni'], [336, '14 dni'], [UNTIL_CLOSE, 'do końca zapisów']]
const WINDOW_TIP = 'Jeśli zgłoszenie nie zostanie opłacone w tym czasie, wygasa i znika z listy zapisanych. Nieopłacone zgłoszenie nie zajmuje miejsca — limit liczy tylko opłacone.'
const EMPTY = { recipient: '', taxId: '', iban: '', title: '' }
const FIELDS = [
  { key: 'recipient', id: 'event-payout-recipient', label: 'Odbiorca', maxLength: 200, wide: true },
  { key: 'taxId', id: 'event-payout-nip', label: 'NIP', inputMode: 'numeric' },
  { key: 'iban', id: 'event-payout-iban', label: 'Numer rachunku', wide: true },
  { key: 'title', id: 'event-payout-title', label: 'Tytuł przelewu · opcjonalnie', maxLength: 140, wide: true },
]

const masked = (iban) => (iban ? `${iban.slice(0, 4)} … ${iban.slice(-4)}` : null)
const label = 'block font-mono text-xs uppercase tracking-wide text-apex-muted mb-1.5'

function Value({ name, children, mono = false }) {
  return (
    <div className="min-w-0">
      <div className={monoLabel}>{name}</div>
      <div className={`${mono ? 'font-mono' : 'font-sans font-medium'} text-base text-apex-text-bright break-words mt-1`}>{children}</div>
    </div>
  )
}

/** The club's own account, as club settings hold it. */
function ClubAccount({ club, payout, isOwner }) {
  if (!payout) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="club-payout-missing">
        <span className="font-sans text-[17px] text-apex-red">Brak danych do wypłat klubu</span>
        {isOwner && (
          <Link to={`/klub/${club.slug}/ustawienia`} className="font-mono text-sm text-apex-yellow whitespace-nowrap no-underline hover:underline">
            USTAWIENIA KLUBU →
          </Link>
        )}
      </div>
    )
  }
  return (
    <div className="grid gap-3.5 grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))]" data-testid="club-payout">
      <Value name="Odbiorca">{payout.legalName}</Value>
      <Value name="Rachunek" mono>{payout.ibanMasked ?? masked(payout.iban)}</Value>
    </div>
  )
}

function Payout({ eventId, role, readOnly, reload }) {
  const { club } = useKlub()
  const isOwner = role === 'owner'
  const [state, setState] = useState({ ready: false, error: null, event: null, club: null })
  const [mode, setMode] = useState('club')
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)

  function seed(ev) {
    setMode(ev?.mode ?? 'club')
    setForm(ev?.mode === 'custom' && isOwner
      ? { recipient: ev.recipient ?? '', taxId: ev.taxId ?? '', iban: groupIban(ev.iban), title: ev.title ?? '' }
      : EMPTY)
  }

  useEffect(() => {
    let live = true
    Promise.all([getEventPayout(eventId), getClubPayout(club.id)])
      .then(([ev, cl]) => {
        if (!live) return
        setState({ ready: true, error: null, event: ev, club: cl })
        seed(ev)
      })
      .catch((err) => { if (live) setState({ ready: true, error: err.message, event: null, club: null }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, club.id])

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await updateEventPayout(eventId, mode === 'club' ? { mode } : { mode, ...form })
      const ev = await getEventPayout(eventId)
      setState((s) => ({ ...s, event: ev }))
      seed(ev)
      setSaved(true)
      await reload()
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (!state.ready) return <div className="h-24 bg-apex-surface-2 animate-pulse" aria-busy="true" />
  if (state.error) return <p className={errorClass}>{state.error}</p>

  const ev = state.event
  const choose = (m) => { setMode(m); setSaved(false) }
  // Nothing to save while the choice and the fields are what is stored (M-2).
  const stored = ev?.mode ?? 'club'
  const unchanged = mode === stored && (mode === 'club' || (
    form.recipient.trim() === (ev?.recipient ?? '') && form.taxId.replace(/[\s-]/g, '') === (ev?.taxId ?? '')
    && form.iban.replace(/\s+/g, '').toUpperCase() === (ev?.iban ?? '') && form.title.trim() === (ev?.title ?? '')))

  return (
    <form onSubmit={save} className="flex flex-col gap-3.5" data-testid="event-payout">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Konto do wypłat">
        <Seg on={mode === 'club'} disabled={!isOwner || readOnly} role="radio" aria-checked={mode === 'club'} onClick={() => choose('club')}>Konto klubu</Seg>
        <Seg on={mode === 'custom'} disabled={!isOwner || readOnly} role="radio" aria-checked={mode === 'custom'} onClick={() => choose('custom')}>Inne konto</Seg>
      </div>

      {mode === 'club' && <ClubAccount club={club} payout={state.club} isOwner={isOwner} />}

      {mode === 'custom' && !isOwner && (
        <div className="grid gap-3.5 grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))]" data-testid="event-payout-masked">
          <Value name="Odbiorca">{ev?.recipient ?? '—'}</Value>
          <Value name="Rachunek" mono>{ev?.ibanMasked ?? '—'}</Value>
        </div>
      )}

      {mode === 'custom' && isOwner && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
          {FIELDS.map((f) => (
            <div key={f.key} className={`min-w-0 ${f.wide ? 'sm:col-span-2' : ''}`}>
              <label htmlFor={f.id} className={label}>{f.label}</label>
              <input id={f.id} type="text" value={form[f.key]} inputMode={f.inputMode} maxLength={f.maxLength} autoComplete="off"
                onChange={(e) => { setForm((s) => ({ ...s, [f.key]: e.target.value })); setSaved(false) }}
                onBlur={f.key === 'iban' ? () => setForm((s) => ({ ...s, iban: groupIban(s.iban) })) : undefined}
                className={`${fieldInput} tabular-nums`} />
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <>
          {saveError && <p role="alert" className={errorClass}>{saveError}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving || readOnly || unchanged} className={btnPrimary}>{saving ? 'Zapisywanie…' : 'Zapisz konto do wypłat'}</button>
            {saved && <span data-testid="event-payout-saved" className={savedClass}>Zapisano</span>}
          </div>
        </>
      )}
    </form>
  )
}

/** '2026-12-06' → '2026-12-05' */
function dayBefore(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

const TRANSFER_TIP = 'Zawodnik może przekazać opłacony pakiet innej osobie. Ta osoba dostaje link, wypełnia formularz zapisu (bez płatności) i dopiero wtedy pakiet przechodzi na nią. Link działa także po zamknięciu zapisów, do podanej daty. Rozliczenie pieniędzy między nimi nas nie dotyczy.'

export default function Platnosci({ event, queue, saveState, readOnly, reload }) {
  const s = event.settings
  const writer = event.role === 'owner' || event.role === 'admin'
  const [choice, setChoice] = useState(s.paymentWindowUntilClose ? UNTIL_CLOSE : (s.paymentWindowHours ?? 168))
  const [transfer, setTransfer] = useState({ enabled: s.transferEnabled === true, until: s.transferUntil ?? '' })
  const errors = sectionErrors(saveState, 'payments')
  const untilId = useId()
  const lastDay = s.eventDate ? dayBefore(s.eventDate) : undefined

  // The whole section each time: autosave keeps one value per section, the latest.
  function send(window, t) {
    queue('payments', {
      ...(window === UNTIL_CLOSE
        ? { paymentWindowUntilClose: true }
        : { paymentWindowHours: window, paymentWindowUntilClose: false }),
      transferEnabled: t.enabled,
      ...(t.enabled ? { transferUntil: t.until || null } : {}),
    })
  }

  function pick(value) {
    setChoice(value)
    send(value, transfer)
  }

  function changeTransfer(next) {
    setTransfer(next)
    send(choice, next)
  }

  // Allowing it starts at the last day it may run to, the day before the race.
  const allow = (on) => changeTransfer(on ? { enabled: true, until: transfer.until || lastDay || '' } : { ...transfer, enabled: false })
  const untilError = errors.transferUntil ?? errors.transferEnabled

  return (
    <div className="space-y-5 min-w-0 max-w-[900px]" data-testid="platnosci-step">
      <section className={cardClass}>
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className={cardTitle}>Czas na opłacenie zgłoszenia</h2>
          <InfoTip label="Co oznacza czas na opłacenie" testId="payment-window-tip">{WINDOW_TIP}</InfoTip>
        </div>
        <fieldset disabled={readOnly} className="flex flex-wrap gap-2 min-w-0" role="radiogroup" aria-label="Czas na opłacenie zgłoszenia">
          {WINDOWS.map(([value, text]) => (
            <Seg key={value} on={choice === value} role="radio" aria-checked={choice === value} onClick={() => pick(value)}>{text}</Seg>
          ))}
        </fieldset>
        <FieldError message={errors.paymentWindowHours ?? errors.paymentWindowUntilClose} />
      </section>

      {writer && (
        <section className={cardClass}>
          <h2 className={cardTitle}>Konto do wypłat</h2>
          <span className="font-mono text-xs uppercase tracking-wide text-apex-yellow">KLUB DOSTAJE 100% OPŁAT STARTOWYCH, DODATKÓW I DAROWIZN</span>
          <Payout eventId={s.eventId} role={event.role} readOnly={readOnly} reload={reload} />
        </section>
      )}

      <section className={cardClass} data-testid="transfer-settings">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className={cardTitle}>Przekazanie pakietu</h2>
          <InfoTip label="Co oznacza przekazanie pakietu" testId="transfer-tip">{TRANSFER_TIP}</InfoTip>
        </div>
        <fieldset disabled={readOnly} className="flex flex-wrap gap-2 min-w-0" role="radiogroup" aria-label="Przekazanie pakietu">
          <Seg on={transfer.enabled} role="radio" aria-checked={transfer.enabled} onClick={() => allow(true)}>Pozwalam przekazać pakiet</Seg>
          <Seg on={!transfer.enabled} role="radio" aria-checked={!transfer.enabled} onClick={() => allow(false)}>Nie pozwalam</Seg>
        </fieldset>
        {transfer.enabled && (
          <div className="max-w-[240px]">
            <label htmlFor={untilId} className={label}>Możliwe do</label>
            <input id={untilId} type="date" value={transfer.until} max={lastDay} disabled={readOnly}
              aria-invalid={untilError ? 'true' : undefined} aria-describedby={untilError ? `${untilId}-err` : undefined}
              onChange={(e) => changeTransfer({ enabled: true, until: e.target.value })}
              className={`${fieldInput} tabular-nums ${untilError ? 'border-apex-red' : ''}`} />
          </div>
        )}
        {untilError && <p id={`${untilId}-err`} className="text-apex-red font-sans text-sm">{untilError}</p>}
      </section>

      {writer && <Vouchers eventId={s.eventId} competitions={event.competitions ?? []} />}
    </div>
  )
}
