import { useId, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { transferTargets } from '../../../../lib/entriesModel.js'
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
  row, competitions, formFields = null, eventDate = null, reckoning = 'race_day', ageGroups = [], onClose, onDone, onFailed,
}) {
  const ids = useId()
  const targets = transferTargets(row, competitions)
  const [categoryId, setCategoryId] = useState(() => (targets.some((c) => c.id === row.categoryId) ? row.categoryId : targets[0]?.id ?? ''))
  const [person, setPerson] = useState({ ...EMPTY_PERSON })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const competition = targets.find((c) => c.id === categoryId) ?? null
  const selectId = `${ids}-category`

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
      // A 422 names its fields under them; any other refusal reads by the button too.
      setError(own ? null : message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="transfer-dialog" title="Przekaż pakiet" subtitle={row.name} busy={busy} onClose={onClose} error={error} wide
      actions={(
        <button type="button" className={btnPrimary} disabled={busy || !categoryId} onClick={transfer}>Przekaż pakiet</button>
      )}>
      <div className="min-w-0">
        <label htmlFor={selectId} className={dialogLabel}>Konkurencja</label>
        <select id={selectId} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={busy || targets.length < 2}
          aria-invalid={fields.categoryId ? 'true' : undefined} aria-describedby={fields.categoryId ? `${selectId}-err` : undefined}
          className={`${dialogInput} ${fields.categoryId ? 'border-apex-red' : ''}`}>
          {targets.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <FieldMessage id={`${selectId}-err`} message={fields.categoryId} />
      </div>
      <PersonForm fields={fieldModes(formFields)} value={person} onChange={(patch) => setPerson((p) => ({ ...p, ...patch }))}
        errors={fields} competition={competition} raceDate={eventDate} reckoning={reckoning}
        ageGroups={ageGroups.filter((g) => g.categoryId === categoryId)} prefill={null} disabled={busy} variant="adult"
        idPrefix={`transfer${ids.replace(/[^a-zA-Z0-9]/g, '')}`} />
    </EntryDialog>
  )
}
