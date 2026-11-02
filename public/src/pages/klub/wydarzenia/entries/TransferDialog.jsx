import { useId, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { filterEntries, transferPersonFrom, transferRecipients, transferTargets } from '../../../../lib/entriesModel.js'
import { EMPTY_PERSON, fieldModes } from '../../../../lib/personFormModel.js'
import PersonForm from '../../../../components/registration/PersonForm.jsx'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from './EntryDialog.jsx'

// ⋯ „Przekaż pakiet” (B3, Plan 7, ruling 4): the organizer types the new holder in, until 00:00
// Warsaw on the race day, after closes_at too. The person is PersonForm's (an added adult, who gets
// Plan 4's consent request naming the club); the competition is one at the same price in the
// entry's frozen tier (`transferTo` from list-event-registrations). organizer-entry-action
// `transfer` decides: a 422 marks its fields, a 409 reads by the button and marks the field it is
// about. The old holder is told only that the package moved (ruling N-1).
// The recipient has usually signed up already (the organizer told them to), so the dialog opens on
// the event's entries: picking one fills the person from it and the request is the same as typed.
// apply_transfer finds that entry by e-mail and, unpaid and alone in its order, replaces it.
// „Osoby nie ma na liście” opens the form for somebody who has not signed up.

// The field a 409 is about, so the dialog points at it as well as saying it.
const REFUSAL_FIELD = {
  recipient_minor: 'birthDate',
  same_person: 'email',
  duplicate: 'email',
  pending_elsewhere: 'email',
  price_differs: 'categoryId',
  team_competition: 'categoryId',
  unavailable: 'categoryId',
}

export default function TransferDialog({
  row, rows = [], competitions, formFields = null, eventDate = null, reckoning = 'race_day', ageGroups = [], onClose, onDone, onFailed,
}) {
  const ids = useId()
  const targets = transferTargets(row, competitions)
  const [categoryId, setCategoryId] = useState(() => (targets.some((c) => c.id === row.categoryId) ? row.categoryId : targets[0]?.id ?? ''))
  const recipients = transferRecipients(rows, row)
  const [mode, setMode] = useState(() => (recipients.some((r) => !r.reason) ? 'pick' : 'type'))
  const [query, setQuery] = useState('')
  const [pickedId, setPickedId] = useState(null)
  const [person, setPerson] = useState({ ...EMPTY_PERSON })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const competition = targets.find((c) => c.id === categoryId) ?? null
  const selectId = `${ids}-category`
  const shown = query.trim() ? filterEntries(recipients, { q: query }) : recipients

  function pick(r) {
    setPickedId(r.id)
    setPerson(transferPersonFrom(r))
    setFields({})
    setError(null)
    if (targets.some((c) => c.id === r.categoryId)) setCategoryId(r.categoryId)
  }

  function switchMode(next) {
    setMode(next)
    setPickedId(null)
    setPerson({ ...EMPTY_PERSON })
    setFields({})
    setError(null)
  }

  async function transfer() {
    setBusy(true)
    setError(null)
    setFields({})
    try {
      await callFunction('organizer-entry-action', { action: 'transfer', registrationId: row.id, categoryId, person })
      onDone({ text: `Pakiet przekazany: ${row.name} → ${`${person.firstName} ${person.lastName}`.trim()}.` })
    } catch (err) {
      const message = err.status == null ? 'Brak połączenia.' : err.message
      const own = err.fields && Object.keys(err.fields).length ? err.fields : null
      const field = REFUSAL_FIELD[err.code]
      setFields(own ?? (field ? { [field]: message } : {}))
      // A 422 names its fields under them; any other refusal reads by the button too. A picked
      // person has no form to mark, so the button reads every message.
      setError(own ? (mode === 'pick' ? Object.values(own).join(' ') : null) : message)
      setBusy(false)
      onFailed()
    }
  }

  const competitionSelect = (
    <div className="min-w-0">
      <label htmlFor={selectId} className={dialogLabel}>Konkurencja</label>
      <select id={selectId} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={busy || targets.length < 2}
        aria-invalid={fields.categoryId ? 'true' : undefined} aria-describedby={fields.categoryId ? `${selectId}-err` : undefined}
        className={`${dialogInput} ${fields.categoryId ? 'border-apex-red' : ''}`}>
        {targets.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <FieldMessage id={`${selectId}-err`} message={fields.categoryId} />
    </div>
  )

  return (
    <EntryDialog testId="transfer-dialog" title="Przekaż pakiet" subtitle={row.name} busy={busy} onClose={onClose} error={error} wide
      actions={(
        <button type="button" className={btnPrimary} disabled={busy || !categoryId || (mode === 'pick' && !pickedId)} onClick={transfer}>Przekaż pakiet</button>
      )}>
      {mode === 'pick' ? (
        <div className="min-w-0 flex flex-col gap-2">
          <label htmlFor={`${ids}-q`} className={dialogLabel}>Komu przekazać</label>
          <input id={`${ids}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} disabled={busy}
            placeholder="Szukaj: imię, nazwisko, e-mail" className={dialogInput} />
          <div role="radiogroup" aria-label="Zapisane osoby" data-testid="transfer-recipients"
            className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
            {shown.map((r) => (
              <label key={r.id} className={`flex items-center gap-2.5 min-h-11 px-3 py-1.5 border min-w-0 ${r.reason
                ? 'border-apex-border opacity-60 cursor-not-allowed' : r.id === pickedId ? 'border-apex-yellow cursor-pointer' : 'border-apex-border-mid cursor-pointer'}`}>
                <input type="radio" name={`${ids}-recipient`} value={r.id} checked={r.id === pickedId} disabled={busy || !!r.reason}
                  onChange={() => pick(r)} className="accent-apex-yellow w-4 h-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block font-sans font-semibold text-base text-apex-text-bright [overflow-wrap:anywhere]">{r.name}</span>
                  <span className="block font-mono text-xs text-apex-muted [overflow-wrap:anywhere]">{r.competition}</span>
                </span>
                <span className={`shrink-0 whitespace-nowrap font-mono text-xs uppercase ${r.reason ? 'text-apex-muted' : 'text-apex-yellow'}`}>
                  {r.reason ?? 'Nieopłacone'}
                </span>
              </label>
            ))}
            {shown.length === 0 && <p className="text-apex-muted text-sm">Nikogo nie znaleziono.</p>}
          </div>
          <button type="button" className="self-start font-sans text-sm text-apex-yellow underline whitespace-nowrap" disabled={busy}
            onClick={() => switchMode('type')}>Osoby nie ma na liście — wpisz dane</button>
          {competitionSelect}
        </div>
      ) : (
        <>
          {recipients.some((r) => !r.reason) && (
            <button type="button" className="self-start font-sans text-sm text-apex-yellow underline whitespace-nowrap" disabled={busy}
              onClick={() => switchMode('pick')}>← Wybierz z listy zapisanych</button>
          )}
          {competitionSelect}
          <PersonForm fields={fieldModes(formFields)} value={person} onChange={(patch) => setPerson((p) => ({ ...p, ...patch }))}
            errors={fields} competition={competition} raceDate={eventDate} reckoning={reckoning}
            ageGroups={ageGroups.filter((g) => g.categoryId === categoryId)} prefill={null} disabled={busy} variant="adult"
            idPrefix={`transfer${ids.replace(/[^a-zA-Z0-9]/g, '')}`} />
        </>
      )}
    </EntryDialog>
  )
}
