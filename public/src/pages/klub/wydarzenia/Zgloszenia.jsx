import { useEffect, useRef, useState } from 'react'
import { formatPln } from '@registration/money.js'
import { callFunction } from '../../../lib/auth.js'
import { countPl, pluralPl } from '../../../lib/plural.js'
import { teamStatusLabel } from '../../../lib/teamPage.js'

// The „Zgłoszenia” tab of a published event (A8): every registration, read
// only — imię i nazwisko, konkurencja, kategoria, regulamin, data zapisu — from
// list-event-registrations. Plan 6's panel (B3) replaces it. The editor mounts
// it (Task 8c); runner data is for the club's owner and admins only.
// Once anybody has paid or owes a payment, the header carries B3's counts
// („X opłaconych · Y czeka na wpłatę”, in the count's Polish form) and a „Płatność” column appears.
// Plan 4 task 6: the „Regulamin” column (each person's consent state), „Czeka na zgody: N” with
// a filter, and on a row still waiting „Przypomnij” (remind-consent) and „Podpisany w biurze”
// (mark-consent-office). Plan 6 moves the two buttons into the row's ⋯ menu.
// Plan 5 task 8: a team not released is one row, „<nazwa> · N os.” / „kapitan: <imię nazwisko>”, with
// its status, „ZGODY a/b” and the one fee, and it opens to its members, who keep every control
// of a person's row. It stands where its first member signed up. A row of a released team, or of
// somebody swapped out, is an ordinary row, read-only history. „Tylko czekające” keeps the teams
// holding somebody waiting, opened to just those people.

const when = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const PAYMENT = { paid: 'opłacone', free: 'bez opłaty' }
const LIVE = new Set(['confirmed', 'pending_payment'])

function paymentColour(r) {
  return r.paymentStatus === 'paid' ? 'text-apex-yellow' : r.paymentStatus === 'awaiting' ? 'text-apex-cyan' : 'text-apex-muted'
}

function paymentText(r) {
  if (r.paymentStatus === 'awaiting') return r.expiresAt ? `czeka na wpłatę do ${when.format(new Date(r.expiresAt))}` : 'czeka na wpłatę'
  return PAYMENT[r.paymentStatus] ?? '—'
}

/** → [text, colour class] of the „Regulamin” cell. */
function consentCell(r) {
  if (!LIVE.has(r.status)) return ['—', 'text-apex-muted']
  if (r.consentState === 'awaiting') return ['czeka na zgodę', 'text-apex-cyan']
  if (r.consentState === 'office') return ['podpisany w biurze', 'text-apex-text-bright']
  if (r.role === 'minor') return ['✓ opiekun', 'text-apex-yellow']
  return ['✓ zaakceptowany', 'text-apex-yellow']
}

const waiting = (r) => r.status === 'confirmed' && r.consentState === 'awaiting'

const smallBtn = 'min-h-9 px-2.5 border font-sans font-bold text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed'
const remindBtn = `${smallBtn} border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim`
const officeBtn = `${smallBtn} border-apex-yellow-dim text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`

/**
 * „Przypomnij” and „Podpisany w biurze” for a row still waiting. The office mark records an acceptance
 * for good and ends the person's link, so it asks „Potwierdzić podpis w biurze: <imię nazwisko>?” first.
 */
function ConsentActions({ row, onOffice }) {
  const [busy, setBusy] = useState(null)
  const [reminded, setReminded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(null)
  const officeRef = useRef(null)

  async function run(kind) {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'remind') {
        await callFunction('remind-consent', { registrationId: row.id })
        setReminded(true)
      } else {
        await callFunction('mark-consent-office', { registrationId: row.id })
        onOffice(row.id)
      }
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : err.message)
    } finally {
      setBusy(null)
      setConfirming(false)
    }
  }

  function cancel() {
    setConfirming(false)
    requestAnimationFrame(() => officeRef.current?.focus())
  }

  const qid = `office-q-${row.id}`
  return (
    <div className="flex flex-col gap-1">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-labelledby={qid} data-testid="office-confirm">
          <span id={qid} className="font-sans font-semibold text-sm text-apex-text-bright">Potwierdzić podpis w biurze: {row.name}?</span>
          <span className="flex gap-1.5">
            <button type="button" className={officeBtn} disabled={busy !== null} onClick={() => run('office')}>Tak</button>
            <button type="button" className={remindBtn} disabled={busy !== null} onClick={cancel} autoFocus>Nie</button>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {reminded
            ? <span className="min-h-9 px-2.5 flex items-center font-mono text-xs uppercase text-apex-muted whitespace-nowrap" data-testid="reminded">Wysłano</span>
            : <button type="button" className={remindBtn} disabled={busy !== null} onClick={() => run('remind')}
                aria-label={`Przypomnij — ${row.name}`}>Przypomnij</button>}
          <button type="button" ref={officeRef} className={officeBtn} disabled={busy !== null} onClick={() => setConfirming(true)}
            aria-label={`Podpisany w biurze — ${row.name}`}>Podpisany w biurze</button>
        </div>
      )}
      {error && <span className="text-apex-red text-xs" role="alert">{error}</span>}
    </div>
  )
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

/** The one fee and, while it is unpaid, its deadline. */
function teamFeeText(t) {
  return [t.fee > 0 ? formatPln(t.fee) : null, t.expiresAt ? `do ${when.format(new Date(t.expiresAt))}` : null].filter(Boolean).join(' · ') || '—'
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

function TeamToggle({ team, open, onToggle }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} aria-label={`Skład — ${team.name}`}
      className={`${smallBtn} border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim`}>
      Skład <span className="font-mono" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
  )
}

function PersonCard({ r, payments, onOffice, testId = 'registration-card' }) {
  const [consentText, consentColour] = consentCell(r)
  return (
    <li className="border border-apex-border bg-apex-surface p-3 flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex justify-between items-start gap-3">
        <span className="min-w-0">
          <span className="block text-apex-text-bright font-semibold">{r.name}</span>
          <SubLine r={r} />
        </span>
        <span className="font-mono text-xs text-apex-muted whitespace-nowrap">{when.format(new Date(r.createdAt))}</span>
      </div>
      <span className="font-mono text-xs uppercase text-apex-muted">{[r.competition, r.ageGroupLabel].filter(Boolean).join(' · ')}</span>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
        {payments && <span className={paymentColour(r)}>{paymentText(r)}</span>}
        <span className={consentColour} data-testid="registration-consent">{consentText}</span>
      </div>
      {waiting(r) && <ConsentActions row={r} onOffice={onOffice} />}
    </li>
  )
}

function TeamCard({ item, payments, open, onToggle, toggles, onOffice }) {
  const { team: t, members } = item
  return (
    <li className="flex flex-col gap-1.5">
      <div className="border border-apex-border-mid bg-apex-surface p-3 flex flex-col gap-1.5" data-testid="team-row">
        <div className="flex justify-between items-start gap-3">
          <span className="min-w-0">
            <span className="block text-apex-text-bright font-semibold [overflow-wrap:anywhere]">{t.name} · {t.size} os.</span>
            {t.captain && <span className="block text-xs text-apex-muted">kapitan: {t.captain}</span>}
          </span>
          {toggles && <TeamToggle team={t} open={open} onToggle={onToggle} />}
        </div>
        <span className="font-mono text-xs uppercase text-apex-muted">{t.competition}</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
          <span className={paymentColour(t)}>{teamStatusLabel(t.paymentStatus)}</span>
          <span className={zgodyColour(t)}>{zgodyText(t)}</span>
          {payments && <span className={paymentColour(t)}>{teamFeeText(t)}</span>}
        </div>
      </div>
      {open && (
        <ul className="flex flex-col gap-1.5 pl-3 border-l-2 border-apex-border-mid">
          {members.map((r) => <PersonCard key={r.id} r={r} payments={false} onOffice={onOffice} testId="team-member" />)}
        </ul>
      )}
    </li>
  )
}

function PersonTableRow({ r, payments, actions, onOffice, member = false }) {
  const [consentText, consentColour] = consentCell(r)
  return (
    <tr className={`border-t border-apex-border align-top ${member ? 'bg-apex-surface' : ''}`} {...(member ? { 'data-testid': 'team-member' } : {})}>
      <td className={`py-2.5 ${member ? 'pl-7 pr-3 min-w-[300px]' : 'px-3'}`}>
        <span className="block text-apex-text-bright font-semibold">{r.name}</span>
        <SubLine r={r} />
        {/* In the name cell, not a column of its own: a team's table has no room left for one. */}
        {member && waiting(r) && <div className="mt-1.5"><ConsentActions row={r} onOffice={onOffice} /></div>}
      </td>
      <td className="px-3 py-2.5">{r.competition}</td>
      <td className="px-3 py-2.5 font-mono">{r.ageGroupLabel}</td>
      {payments && (
        <td className={`px-3 py-2.5 font-mono whitespace-nowrap ${member ? 'text-apex-muted' : paymentColour(r)}`} data-testid="registration-payment">
          {member ? '' : paymentText(r)}
        </td>
      )}
      <td className={`px-3 py-2.5 font-mono whitespace-nowrap ${consentColour}`} data-testid="registration-consent">{consentText}</td>
      <td className="px-3 py-2.5 font-mono whitespace-nowrap">{when.format(new Date(r.createdAt))}</td>
      {actions && <td className="px-3 py-2">{!member && waiting(r) && <ConsentActions row={r} onOffice={onOffice} />}</td>}
    </tr>
  )
}

function TeamTableRows({ item, payments, actions, open, onToggle, toggles, onOffice }) {
  const { team: t, members } = item
  return (
    <>
      <tr className="border-t border-apex-border-mid align-top" data-testid="team-row">
        <td className="px-3 py-2.5 min-w-[260px]">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-apex-text-bright font-semibold break-words">{t.name} · {t.size} os.</span>
              {t.captain && <span className="block text-xs text-apex-muted">kapitan: {t.captain}</span>}
            </span>
            {toggles && <TeamToggle team={t} open={open} onToggle={onToggle} />}
          </div>
        </td>
        <td className="px-3 py-2.5">{t.competition}</td>
        <td className={`px-3 py-2.5 font-mono text-xs whitespace-nowrap ${paymentColour(t)}`}>{teamStatusLabel(t.paymentStatus)}</td>
        {payments && <td className={`px-3 py-2.5 font-mono ${paymentColour(t)}`}>{teamFeeText(t)}</td>}
        <td className={`px-3 py-2.5 font-mono whitespace-nowrap ${zgodyColour(t)}`}>{zgodyText(t)}</td>
        <td className="px-3 py-2.5 font-mono whitespace-nowrap">{when.format(new Date(members[0].createdAt))}</td>
        {actions && <td className="px-3 py-2" />}
      </tr>
      {open && members.map((r) => <PersonTableRow key={r.id} r={r} payments={payments} actions={actions} onOffice={onOffice} member />)}
    </>
  )
}

export default function Zgloszenia({ eventId }) {
  const [state, setState] = useState({ status: 'loading', rows: [], counts: null, teams: [] })
  const [onlyWaiting, setOnlyWaiting] = useState(false)
  const [openTeams, setOpenTeams] = useState(() => new Set())

  useEffect(() => {
    let active = true
    callFunction('list-event-registrations', { eventId })
      .then((r) => { if (active) setState({ status: 'ok', rows: r.data ?? [], counts: r.counts ?? null, teams: r.teams ?? [] }) })
      .catch(() => { if (active) setState({ status: 'error', rows: [], counts: null, teams: [] }) })
    return () => { active = false }
  }, [eventId])

  if (state.status === 'loading') {
    return <div className="flex flex-col gap-1.5" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-11 bg-apex-surface" />)}</div>
  }
  if (state.status === 'error') return <p className="text-apex-red text-sm">Nie udało się wczytać zgłoszeń.</p>
  if (state.rows.length === 0) return <p className="text-apex-muted text-sm" data-testid="registrations-empty">Brak zgłoszeń.</p>

  const counts = state.counts
  const payments = !!counts && counts.paid + counts.awaiting > 0
  const awaitingConsent = counts?.awaitingConsent ?? state.rows.filter(waiting).length
  // The consent header appears once anybody was added by somebody else, and stays at 0 after the last one is settled.
  const consentHeader = awaitingConsent > 0 || state.rows.some((r) => r.role === 'adult')
  const liveTeams = new Set(state.teams.map((t) => t.id))
  const actions = state.rows.some((r) => waiting(r) && !liveTeams.has(r.team?.id))
  const items = listItems(onlyWaiting ? state.rows.filter(waiting) : state.rows, state.teams)
  const isOpen = (id) => onlyWaiting || openTeams.has(id)
  const toggle = (id) => setOpenTeams((ids) => {
    const next = new Set(ids)
    if (!next.delete(id)) next.add(id)
    return next
  })

  function markedOffice(id) {
    setState((s) => {
      const teamId = s.rows.find((r) => r.id === id)?.team?.id
      return {
        ...s,
        rows: s.rows.map((r) => (r.id === id ? { ...r, consentState: 'office' } : r)),
        counts: s.counts ? { ...s.counts, awaitingConsent: Math.max(0, (s.counts.awaitingConsent ?? 0) - 1) } : s.counts,
        teams: s.teams.map((t) => (t.id === teamId ? { ...t, consentAccepted: t.consentAccepted + 1 } : t)),
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 min-w-0 max-w-full">
      {payments && (
        <p className="font-mono text-xs uppercase text-apex-muted" data-testid="registrations-counts">
          <span className="text-apex-yellow">{countPl(counts.paid, ['opłacone', 'opłacone', 'opłaconych'])}</span> · <span className="text-apex-cyan">{counts.awaiting} {pluralPl(counts.awaiting, 'czeka', 'czekają', 'czeka')} na wpłatę</span>
          {counts.free > 0 && <> · {counts.free} bez opłaty</>}
          {counts.placesLeft != null && <> · <span className="text-apex-text-bright" data-testid="registrations-places-left">{countPl(counts.placesLeft, ['wolne miejsce', 'wolne miejsca', 'wolnych miejsc'])}</span></>}
        </p>
      )}
      {consentHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="awaiting-consent">
          <span className={`font-mono text-xs uppercase ${awaitingConsent > 0 ? 'text-apex-cyan' : 'text-apex-muted'}`}>Czeka na zgody: {awaitingConsent}</span>
          <button type="button" aria-pressed={onlyWaiting} onClick={() => setOnlyWaiting((v) => !v)}
            className={`${smallBtn} ${onlyWaiting ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-bright text-apex-text'}`}>
            Tylko czekające
          </button>
        </div>
      )}
      {/* Under 640 px every person is a card: the state and the buttons stay in view, nothing scrolls sideways. */}
      <ul className="sm:hidden flex flex-col gap-2" data-testid="registrations-cards">
        {items.map((item) => (item.team
          ? <TeamCard key={item.key} item={item} payments={payments} open={isOpen(item.key)} toggles={!onlyWaiting}
              onToggle={() => toggle(item.key)} onOffice={markedOffice} />
          : <PersonCard key={item.key} r={item.person} payments={payments} onOffice={markedOffice} />))}
      </ul>
      <div className="hidden sm:block relative border border-apex-border overflow-x-auto max-w-full" data-testid="registrations">
        <table className="w-full text-sm">
          <thead className="bg-apex-surface-2 font-mono text-[10px] tracking-widest uppercase text-apex-muted text-left">
            <tr>
              <th className="px-3 py-2 font-normal">Imię i nazwisko</th>
              <th className="px-3 py-2 font-normal">Konkurencja</th>
              <th className="px-3 py-2 font-normal">Kategoria</th>
              {payments && <th className="px-3 py-2 font-normal">Płatność</th>}
              <th className="px-3 py-2 font-normal">Regulamin</th>
              <th className="px-3 py-2 font-normal whitespace-nowrap">Data zapisu</th>
              {actions && <th className="px-3 py-2 font-normal"><span className="sr-only">Akcje</span></th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (item.team
              ? <TeamTableRows key={item.key} item={item} payments={payments} actions={actions} open={isOpen(item.key)} toggles={!onlyWaiting}
                  onToggle={() => toggle(item.key)} onOffice={markedOffice} />
              : <PersonTableRow key={item.key} r={item.person} payments={payments} actions={actions} onOffice={markedOffice} />))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
