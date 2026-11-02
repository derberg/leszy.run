import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatPln } from '@registration/money.js'
import { statusLabel } from '@registration/entries.js'
import { warsawToday } from '@registration/dates.js'
import { callFunction } from '../../../lib/auth.js'
import { downloadCsv } from '../../../lib/csvDownload.js'
import {
  AWAITING_CONSENT, competitionChips, entryActions, entryCounts, filterEntries, listedTile, noPlacesForAwaiting, partnerChips,
  statusChips,
} from '../../../lib/entriesModel.js'
import { teamStatusLabel } from '../../../lib/teamPage.js'
import { btnGhost, btnPrimary } from '../settingsUi.js'
import EntryMenu from './entries/EntryMenu.jsx'
import CancelDialog from './entries/CancelDialog.jsx'
import EditEntryDialog from './entries/EditEntryDialog.jsx'
import ExtendDialog from './entries/ExtendDialog.jsx'
import MessageDialog from './entries/MessageDialog.jsx'
import PartnerDialog from './entries/PartnerDialog.jsx'
import RefundDialog from './entries/RefundDialog.jsx'
import RenameTeamDialog from './entries/RenameTeamDialog.jsx'
import TransferDialog from './entries/TransferDialog.jsx'

// The „Zgłoszenia” tab of a published event: the organizer's entries panel (B3). Plan 2's
// PublishedHeader above the tabs carries the event name, date and state; this adds no second
// header (D6-8). From list-event-registrations (owner and admins only, P2-R20): the tiles, the
// competition and status chips, the search, the table (cards under 640 px), the CSV export and each
// row's ⋯ menu (entryActions). Plan 4's „Przypomnij” and „Podpisany w biurze” live in that menu now.
// A team not released is one row, „<nazwa> · N os.” / „kapitan: …” / „ZGODY a/b”, standing where
// its first member signed up, and opens to its members, who keep every action of a person's row.
// Every action re-reads the list, whether it succeeded or not. The ⋯ items that need more than a
// click open a dialog (entries/): refund, extend, cancel, edit, message (B3a) and rename; the
// dialog reads its row fresh from the list and gives the focus back to the ⋯ when it closes.
// Plan 7 adds the partner (organizer-only, V-38): a „Partner” column and the „Partnerzy” chips
// while the event has partners, ⋯ „Partner” (PartnerDialog) and ⋯ „Przekaż pakiet”
// (TransferDialog, the organizer's transfer, until the race day).

const LIVE = new Set(['confirmed', 'pending_payment'])
// Online payment, and with it the reminder and the extension, stops an hour before closes_at
// (organizer-entry-action's paying_closed).
const PAYING_CLOSES_BEFORE_MS = 3600_000

const STATUS_COLOUR = {
  paid: 'text-apex-yellow',
  free: 'text-apex-yellow',
  awaiting: 'text-apex-cyan',
  refund_unconfirmed: 'text-apex-red',
  withdraw_on_host: 'text-apex-red',
}
const statusColour = (key) => STATUS_COLOUR[key] ?? 'text-apex-muted'

const teamColour = (t) => (t.paymentStatus === 'paid' || t.paymentStatus === 'free' ? 'text-apex-yellow'
  : t.paymentStatus === 'awaiting' ? 'text-apex-cyan' : 'text-apex-muted')

/** → [text, colour class] of a person's consent line, or null when there is nothing to say. */
function consentLine(r) {
  if (!LIVE.has(r.status)) return null
  if (r.consentState === 'awaiting') return ['czeka na zgodę', 'text-apex-cyan']
  if (r.consentState === 'office') return ['podpisany w biurze', 'text-apex-text-bright']
  // A runner who signed up themselves accepted on the form: nothing to show.
  if (r.role === 'minor') return ['✓ opiekun', 'text-apex-yellow']
  if (r.role === 'adult') return ['✓ zaakceptowany', 'text-apex-yellow']
  return null
}

/** The sub-line under a name: the guardian of a child, or who added an adult. */
function subLine(r) {
  if (r.role === 'minor') return r.guardianRemoved ? 'kontakt opiekuna usunięty' : r.guardianName ? `opiekun: ${r.guardianName}` : null
  return r.registeredBy ? `zapisał(a): ${r.registeredBy}` : null
}

function SubLine({ r }) {
  const sub = subLine(r)
  if (!sub) return null
  return (
    <span className={`block text-xs ${r.guardianRemoved ? 'text-apex-red' : 'text-apex-muted'}`}
      data-testid={r.guardianRemoved ? 'guardian-removed' : 'registration-sub'}>{sub}</span>
  )
}

function ConsentLine({ r }) {
  const line = consentLine(r)
  if (!line) return null
  return <span className={`block font-mono text-xs ${line[1]}`} data-testid="registration-consent">{line[0]}</span>
}

function payment(r) {
  if (r.paidAmount > 0) return [formatPln(r.paidAmount), 'text-apex-text-bright']
  if (r.statusKey === 'awaiting' && r.price > 0) return [formatPln(r.price), 'text-apex-muted']
  return ['—', 'text-apex-muted']
}

const zgodyText = (t) => `ZGODY ${t.consentAccepted}/${t.size}`
const zgodyColour = (t) => (t.consentAccepted < t.size ? 'text-apex-cyan' : 'text-apex-yellow')

/** The rows as they read top to bottom: a person, or a team where its first member stood. */
function listItems(rows, teams) {
  const teamOf = new Map(teams.map((t) => [t.id, t]))
  const inTeam = (r) => LIVE.has(r.status) && teamOf.has(r.team?.id)
  const seen = new Set()
  const items = []
  for (const r of rows) {
    if (!inTeam(r)) items.push({ key: r.id, person: r })
    else if (!seen.has(r.team.id)) {
      seen.add(r.team.id)
      items.push({ key: r.team.id, team: teamOf.get(r.team.id), members: rows.filter((m) => inTeam(m) && m.team.id === r.team.id) })
    }
  }
  return items
}

const smallBtn = 'min-h-9 px-2.5 border font-sans font-bold text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed'

function TeamToggle({ team, open, onToggle }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} aria-label={`Skład — ${team.name}`}
      className={`${smallBtn} border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim`}>
      Skład <span className="font-mono" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
  )
}

function Tile({ label, value, extra, tone = 'text-apex-text-bright', testId }) {
  // text-base at every width: at 1440 a four-tile row is about 250 px, and „3 / 22 · 1 / 10 DRUŻYN”
  // then keeps to one line instead of leaving „· 1 / 10 DRUŻYN” alone on the second.
  return (
    <div className="border border-apex-border-mid bg-apex-surface px-3.5 py-3 min-w-0" data-testid={testId}>
      <span className="block font-mono text-[11px] tracking-widest uppercase text-apex-muted">{label}</span>
      {/* Each part keeps to one line; a narrow tile breaks only between them. */}
      <span className={`block mt-1 font-mono text-base leading-6 ${tone}`}>
        {value.split(' · ').map((part, i) => (
          <Fragment key={part + i}>{i > 0 && ' '}<span className="whitespace-nowrap">{i > 0 && '· '}{part}</span></Fragment>
        ))}
        {extra && <> <span className="whitespace-nowrap text-apex-red">{extra}</span></>}
      </span>
    </div>
  )
}

function Chips({ label, chips, selected, onPick, testId }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5" data-testid={testId}>
      {chips.map((c) => {
        const on = c.id === selected
        return (
          <button key={c.id ?? 'all'} type="button" aria-pressed={on} onClick={() => onPick(c.id)}
            className={`min-h-9 px-3 border font-sans font-semibold text-sm whitespace-nowrap ${on
              ? 'border-apex-yellow bg-apex-surface-2 text-apex-yellow'
              : 'border-apex-border-bright text-apex-text hover:border-apex-yellow-dim hover:text-apex-text-bright'}`}>
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

/** Asks before the office mark: it records an acceptance for good and ends the person's link. */
function OfficeConfirm({ row, busy, onYes, onNo }) {
  const titleId = useId()
  const no = useRef(null)
  useEffect(() => { no.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onNo() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onNo])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} data-testid="office-confirm"
        className="w-full max-w-[420px] border border-apex-border-bright bg-apex-surface p-5 flex flex-col gap-4">
        <p id={titleId} className="font-sans font-semibold text-base text-apex-text-bright">Potwierdzić podpis w biurze: {row.name}?</p>
        <div className="flex gap-2 justify-end">
          <button type="button" ref={no} className={btnGhost} disabled={busy} onClick={onNo}>Nie</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={onYes}>Tak</button>
        </div>
      </div>
    </div>
  )
}

function rowMenu(r, ctx, { isTeamRow = false, menuRow = r, name = r.name, squadHref = null } = {}) {
  const actions = entryActions(menuRow, {
    closed: ctx.closed, payingClosed: ctx.payingClosed, raceDay: ctx.raceDay, isTeamRow, full: ctx.fullCategories.has(menuRow.categoryId),
    isCaptain: ctx.captainIds.has(menuRow.id),
  }).filter((a) => a !== 'squad' || squadHref) // no address for the team page without the event's slug
    // Nothing to pick while the event has no partner, unless the entry still carries one to clear.
    .filter((a) => a !== 'partner' || ctx.hasPartners || menuRow.partnerId)
  return (
    <EntryMenu name={name} row={menuRow} actions={actions} isTeamRow={isTeamRow} isCaptain={ctx.captainIds.has(menuRow.id)} squadHref={squadHref}
      onSelect={(action, trigger) => ctx.onAction(action, menuRow, { isTeamRow, trigger })} />
  )
}

function PersonCard({ r, ctx, testId = 'registration-card' }) {
  const [amount, amountColour] = payment(r)
  return (
    <li className="border border-apex-border bg-apex-surface p-3 flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex justify-between items-start gap-3">
        <span className="min-w-0">
          <span className="block text-apex-text-bright font-semibold [overflow-wrap:anywhere]">
            {r.bib != null && <span className="font-mono text-apex-muted mr-1.5">{r.bib}</span>}{r.name}
          </span>
          <SubLine r={r} />
        </span>
        {rowMenu(r, ctx)}
      </div>
      <span className="font-mono text-xs uppercase text-apex-muted">{[r.competition, r.ageGroupLabel].filter(Boolean).join(' · ')}</span>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-sm">
        <span className={statusColour(r.statusKey)} data-testid="registration-status">{statusLabel(r.statusKey, r)}</span>
        <span className={amountColour}>{amount}</span>
      </div>
      <ConsentLine r={r} />
      {ctx.hasPartners && r.partnerName && (
        <span className="font-mono text-xs text-apex-muted [overflow-wrap:anywhere]" data-testid="registration-partner">PARTNER: {r.partnerName}</span>
      )}
    </li>
  )
}

function TeamCard({ item, ctx, open, onToggle, toggles }) {
  const { team: t, members } = item
  const captain = ctx.rowOf(t.captainId)
  return (
    <li className="flex flex-col gap-1.5">
      <div className="border border-apex-border-mid bg-apex-surface p-3 flex flex-col gap-1.5" data-testid="team-row">
        <div className="flex justify-between items-start gap-3">
          <span className="min-w-0">
            <span className="block text-apex-text-bright font-semibold [overflow-wrap:anywhere]">{t.name} · {t.size} os.</span>
            {t.captain && <span className="block text-xs text-apex-muted">kapitan: {t.captain}</span>}
            <span className={`block font-mono text-xs ${zgodyColour(t)}`}>{zgodyText(t)}</span>
          </span>
          <span className="flex gap-1.5 shrink-0">
            {toggles && <TeamToggle team={t} open={open} onToggle={onToggle} />}
            {captain && rowMenu(captain, ctx, { isTeamRow: true, name: t.name, squadHref: ctx.squadHref(t.id) })}
          </span>
        </div>
        <span className="font-mono text-xs uppercase text-apex-muted">{t.competition}</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
          <span className={teamColour(t)}>{teamStatusLabel(t.paymentStatus)}</span>
          {t.fee > 0 && <span className="text-apex-text-bright">{formatPln(t.fee)}</span>}
        </div>
      </div>
      {open && (
        <ul className="flex flex-col gap-1.5 pl-3 border-l-2 border-apex-border-mid">
          {members.map((r) => <PersonCard key={r.id} r={r} ctx={ctx} testId="team-member" />)}
        </ul>
      )}
    </li>
  )
}

const td = 'px-3 py-2.5'

function PersonTableRow({ r, ctx, member = false }) {
  const [amount, amountColour] = payment(r)
  return (
    <tr className={`border-t border-apex-border align-top ${member ? 'bg-apex-surface' : ''}`}
      data-testid={member ? 'team-member' : 'registration-row'}>
      <td className={`${td} font-mono text-apex-muted whitespace-nowrap`}>{r.bib ?? '—'}</td>
      <td className={`py-2.5 ${member ? 'pl-7 pr-3' : 'px-3'} min-w-[200px]`}>
        <span className="block text-apex-text-bright font-semibold">{r.name}</span>
        <SubLine r={r} />
      </td>
      <td className={td}>
        <span className="block">{r.competition}</span>
        {r.ageGroupLabel && <span className="block font-mono text-xs text-apex-muted">{r.ageGroupLabel}</span>}
      </td>
      <td className={td}>
        <span className={`block font-mono text-xs whitespace-nowrap ${statusColour(r.statusKey)}`} data-testid="registration-status">
          {statusLabel(r.statusKey, r)}
        </span>
        <ConsentLine r={r} />
      </td>
      <td className={`${td} font-mono whitespace-nowrap ${member ? 'text-apex-muted' : amountColour}`} data-testid="registration-payment">
        {member && r.paidAmount === 0 ? '' : amount}
      </td>
      {ctx.hasPartners && (
        <td className={`${td} min-w-[120px] ${r.partnerName ? 'text-apex-text-bright' : 'text-apex-muted'}`} data-testid="registration-partner">
          {r.partnerName ?? '—'}
        </td>
      )}
      <td className="px-3 py-2 text-right">{rowMenu(r, ctx)}</td>
    </tr>
  )
}

function TeamTableRows({ item, ctx, open, onToggle, toggles }) {
  const { team: t, members } = item
  const captain = ctx.rowOf(t.captainId)
  return (
    <>
      <tr className="border-t border-apex-border-mid align-top" data-testid="team-row">
        <td className={`${td} font-mono text-apex-muted`}>—</td>
        <td className={`${td} min-w-[240px]`}>
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-apex-text-bright font-semibold break-words">{t.name} · {t.size} os.</span>
              {t.captain && <span className="block text-xs text-apex-muted">kapitan: {t.captain}</span>}
              <span className={`block font-mono text-xs ${zgodyColour(t)}`}>{zgodyText(t)}</span>
            </span>
            {toggles && <TeamToggle team={t} open={open} onToggle={onToggle} />}
          </div>
        </td>
        <td className={td}>{t.competition}</td>
        <td className={`${td} font-mono text-xs whitespace-nowrap ${teamColour(t)}`}>{teamStatusLabel(t.paymentStatus)}</td>
        <td className={`${td} font-mono whitespace-nowrap text-apex-text-bright`}>{t.fee > 0 ? formatPln(t.fee) : '—'}</td>
        {ctx.hasPartners && <td className={td} />}
        <td className="px-3 py-2 text-right">
          {captain && rowMenu(captain, ctx, { isTeamRow: true, name: t.name, squadHref: ctx.squadHref(t.id) })}
        </td>
      </tr>
      {open && members.map((r) => <PersonTableRow key={r.id} r={r} ctx={ctx} member />)}
    </>
  )
}

const EMPTY = { status: 'loading', rows: [], teams: [], competitions: [], event: null, partners: [] }

export default function Zgloszenia({
  eventId, clubName = null, contactEmail = null, formFields = null, ageGroups = [], reckoning = 'race_day', charity = false,
}) {
  const [state, setState] = useState(EMPTY)
  const [categoryId, setCategoryId] = useState(null)
  const [statusKey, setStatusKey] = useState(null)
  const [partnerId, setPartnerId] = useState(null)
  const [q, setQ] = useState('')
  const [openTeams, setOpenTeams] = useState(() => new Set())
  const [notice, setNotice] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [office, setOffice] = useState(null)
  const [officeBusy, setOfficeBusy] = useState(false)
  // The open dialog: { kind, row, isTeamRow, trigger }; closing it focuses `trigger`.
  const [dialog, setDialog] = useState(null)
  const searchId = useId()

  const load = useCallback(async () => {
    try {
      const r = await callFunction('list-event-registrations', { eventId })
      setState({
        status: 'ok', rows: r.data ?? [], teams: r.teams ?? [], competitions: r.competitions ?? [], event: r.event ?? null,
        partners: r.partners ?? [],
      })
    } catch {
      setState((s) => (s.status === 'ok' ? s : { ...EMPTY, status: 'error' }))
    }
  }, [eventId])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => entryCounts(state.rows, state.competitions), [state.rows, state.competitions])

  if (state.status === 'loading') {
    return <div className="flex flex-col gap-1.5" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-11 bg-apex-surface" />)}</div>
  }
  if (state.status === 'error') return <p className="text-apex-red text-sm">Nie udało się wczytać zgłoszeń.</p>
  if (state.rows.length === 0) return <p className="text-apex-muted text-sm" data-testid="registrations-empty">Brak zgłoszeń.</p>

  const failed = (err) => setNotice({ text: err.status == null ? 'Brak połączenia.' : err.message, error: true })
  const event = state.event ?? {}
  const now = new Date()
  const closed = event.closesAt ? now >= new Date(event.closesAt) : false
  const payingClosed = event.closesAt ? now.getTime() >= Date.parse(event.closesAt) - PAYING_CLOSES_BEFORE_MS : false
  const raceDay = event.eventDate ? warsawToday(now) >= event.eventDate : false
  const byId = new Map(state.rows.map((r) => [r.id, r]))
  // A partner deleted meanwhile is no filter any more.
  const partnerFilter = partnerId && state.partners.some((p) => p.id === partnerId) ? partnerId : undefined
  const filter = { categoryId: categoryId ?? undefined, statusKey: statusKey ?? undefined, partnerId: partnerFilter, q }
  const consentView = statusKey === AWAITING_CONSENT
  const items = listItems(filterEntries(state.rows, filter), state.teams)
  const isOpen = (id) => consentView || openTeams.has(id)
  const toggle = (id) => setOpenTeams((ids) => {
    const next = new Set(ids)
    if (!next.delete(id)) next.add(id)
    return next
  })

  async function remind(fn, body, row, trigger) {
    setNotice(null)
    trigger?.focus()
    try {
      await callFunction(fn, body)
      setNotice({ text: `Przypomnienie wysłane — ${row.name}.` })
      await load()
    } catch (err) {
      failed(err)
      await load()
    }
  }

  function onAction(action, row, { isTeamRow, trigger }) {
    if (action === 'remind_payment') return remind('organizer-entry-action', { action: 'remind_payment', registrationId: row.id }, row, trigger)
    if (action === 'remind_consent') return remind('remind-consent', { registrationId: row.id }, row, trigger)
    if (action === 'consent_office') return setOffice({ row, trigger })
    setDialog({ kind: action, row, isTeamRow, trigger })
    return undefined
  }

  function closeOffice() {
    const back = office?.trigger
    setOffice(null)
    requestAnimationFrame(() => back?.focus())
  }

  async function markOffice() {
    setOfficeBusy(true)
    setNotice(null)
    try {
      await callFunction('mark-consent-office', { registrationId: office.row.id })
    } catch (err) {
      failed(err)
    } finally {
      await load()
      setOfficeBusy(false)
      closeOffice()
    }
  }

  async function exportCsv() {
    setExporting(true)
    setNotice(null)
    try {
      const filterBody = Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v === 'string' && v !== ''))
      const r = await callFunction('export-event-registrations', { eventId, filter: filterBody })
      downloadCsv(r.data.filename, r.data.csv)
    } catch (err) {
      failed(err)
    } finally {
      setExporting(false)
    }
  }

  function closeDialog() {
    const back = dialog?.trigger
    setDialog(null)
    requestAnimationFrame(() => { if (back?.isConnected) back.focus() })
  }

  async function dialogDone(result) {
    closeDialog()
    setNotice(result)
    await load()
  }

  const ctx = {
    closed,
    payingClosed,
    raceDay,
    captainIds: new Set(state.teams.map((t) => t.captainId)),
    fullCategories: new Set(counts.perCompetition.filter((c) => c.listed >= c.capacity).map((c) => c.id)),
    onAction,
    rowOf: (id) => byId.get(id) ?? null,
    hasPartners: state.partners.length > 0,
    squadHref: (teamId) => (event.slug ? `/events/${event.slug}/druzyna/${teamId}` : null),
  }
  const blocked = noPlacesForAwaiting(counts) && counts.awaiting > 0

  function renderDialog() {
    // The row as the list holds it now: a refusal re-reads the list, and the dialog follows.
    const row = dialog.row ? (byId.get(dialog.row.id) ?? dialog.row) : null
    const captainOf = row ? state.teams.find((t) => t.captainId === row.id) ?? null : null
    const common = { onClose: closeDialog, onDone: dialogDone, onFailed: load }
    switch (dialog.kind) {
      case 'refund': return <RefundDialog row={row} team={captainOf} charity={charity} {...common} />
      case 'extend': return <ExtendDialog row={row} closesAt={event.closesAt ?? null} {...common} />
      case 'cancel': {
        // An unpaid entry cancels its whole order (D6-24): the dialog names everyone in it (ruling 6).
        const orderRows = row.statusKey === 'awaiting' && row.orderId
          ? state.rows.filter((r) => r.orderId === row.orderId && r.status === 'pending_payment')
          : [row]
        return <CancelDialog row={row} team={captainOf} orderRows={orderRows} {...common} />
      }
      case 'edit': return <EditEntryDialog row={row} formFields={formFields} {...common} />
      case 'rename_team': return captainOf ? <RenameTeamDialog team={captainOf} {...common} /> : null
      case 'partner': return <PartnerDialog row={row} partners={state.partners} {...common} />
      case 'transfer':
        return (
          <TransferDialog row={row} rows={state.rows} competitions={state.competitions} formFields={formFields} eventDate={event.eventDate ?? null}
            reckoning={reckoning} ageGroups={ageGroups} {...common} />
        )
      case 'message':
        return (
          <MessageDialog eventId={eventId} row={row} isTeamRow={dialog.isTeamRow} team={captainOf} competitions={state.competitions}
            clubName={clubName} contactEmail={contactEmail} {...common} />
        )
      default: return null
    }
  }

  return (
    <div className="flex flex-col gap-3 min-w-0 max-w-full">
      <div className="flex flex-wrap gap-2" data-testid="entries-actions">
        <button type="button" className={btnGhost}
          onClick={(e) => setDialog({ kind: 'message', row: null, isTeamRow: false, trigger: e.currentTarget })}>
          Wiadomość do uczestników
        </button>
        <button type="button" className={btnGhost} disabled={exporting} onClick={exportCsv}>Eksport CSV</button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Tile testId="tile-listed" label="NA LIŚCIE" value={listedTile(counts)} tone="text-apex-yellow" />
        <Tile testId="tile-awaiting" label="CZEKA NA WPŁATĘ" value={String(counts.awaiting)}
          extra={blocked ? '· BRAK MIEJSC' : null} tone="text-apex-cyan" />
        <Tile testId="tile-consent" label="CZEKA NA ZGODY" value={String(counts.awaitingConsent)}
          tone={counts.awaitingConsent > 0 ? 'text-apex-cyan' : 'text-apex-text-bright'} />
        <Tile testId="tile-income" label="WPŁYWY DLA KLUBU" value={formatPln(counts.clubIncome)} />
      </div>

      <Chips testId="competition-chips" label="Konkurencja" chips={competitionChips(state.rows, state.competitions, state.teams)}
        selected={categoryId} onPick={setCategoryId} />
      <Chips testId="status-chips" label="Status" chips={statusChips(counts).map((c) => ({ id: c.key, label: c.label }))}
        selected={statusKey} onPick={setStatusKey} />
      {state.partners.length > 0 && (
        <Chips testId="partner-chips" label="Partnerzy" chips={partnerChips(state.rows, state.partners)}
          selected={partnerFilter ?? null} onPick={setPartnerId} />
      )}
      <div className="max-w-[360px]">
        <label htmlFor={searchId} className="sr-only">Szukaj</label>
        <input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj"
          className="w-full min-w-0 bg-apex-bg border border-apex-border-mid text-apex-text-bright font-sans text-base font-medium py-2 px-3 outline-none focus:border-apex-yellow-dim" />
      </div>

      {notice && (
        <p role={notice.error ? 'alert' : 'status'} data-testid="entries-notice"
          className={`font-sans text-sm ${notice.error ? 'text-apex-red' : 'text-apex-yellow'}`}>{notice.text}</p>
      )}

      {items.length === 0 ? <p className="text-apex-muted text-sm" data-testid="registrations-none">Brak wyników.</p> : (
        <>
          {/* Under 640 px every entry is a card: the state and the ⋯ stay in view, nothing scrolls sideways. */}
          <ul className="sm:hidden flex flex-col gap-2" data-testid="registrations-cards">
            {items.map((item) => (item.team
              ? <TeamCard key={item.key} item={item} ctx={ctx} open={isOpen(item.key)} toggles={!consentView}
                  onToggle={() => toggle(item.key)} />
              : <PersonCard key={item.key} r={item.person} ctx={ctx} />))}
          </ul>
          <div className="hidden sm:block relative border border-apex-border overflow-x-auto max-w-full" data-testid="registrations">
            <table className="w-full text-sm">
              <thead className="bg-apex-surface-2 font-mono text-[10px] tracking-widest uppercase text-apex-muted text-left">
                <tr>
                  <th className="px-3 py-2 font-normal">Nr</th>
                  <th className="px-3 py-2 font-normal whitespace-nowrap">Zawodnik / drużyna</th>
                  <th className="px-3 py-2 font-normal">Konkurencja</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                  <th className="px-3 py-2 font-normal">Wpłata</th>
                  {state.partners.length > 0 && <th className="px-3 py-2 font-normal">Partner</th>}
                  <th className="px-3 py-2 font-normal"><span className="sr-only">Akcje</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (item.team
                  ? <TeamTableRows key={item.key} item={item} ctx={ctx} open={isOpen(item.key)} toggles={!consentView}
                      onToggle={() => toggle(item.key)} />
                  : <PersonTableRow key={item.key} r={item.person} ctx={ctx} />))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {office && <OfficeConfirm row={office.row} busy={officeBusy} onYes={markOffice} onNo={closeOffice} />}
      {dialog && renderDialog()}
    </div>
  )
}
