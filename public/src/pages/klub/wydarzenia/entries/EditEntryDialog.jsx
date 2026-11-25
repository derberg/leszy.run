import { useId, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog from './EntryDialog.jsx'
import PersonEditFields, { changedFields, initialPerson } from '../../../../components/registration/PersonEditFields.jsx'

// „Edytuj dane” (B3): the person's fields prefilled from the row; only what changed goes to
// organizer-entry-action edit, which runs the form's own validatePerson and answers a 422 with
// `fields`, each shown under its input. The e-mail is never editable. Miejscowość, Klub, the
// emergency contact and Narodowość follow the event's form switches (organizer_edit_registration
// refuses a value in a field switched off), and a field switched off still shows while the entry
// holds a value in it (PersonEditFields). Until closes_at only (the ⋯ hides it after).

export default function EditEntryDialog({ row, formFields = null, onClose, onDone, onFailed }) {
  const ids = useId()
  const [start] = useState(() => initialPerson(row))
  const [value, setValue] = useState(start)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})

  async function save() {
    const changed = changedFields(start, value)
    if (!Object.keys(changed).length) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    setFields({})
    try {
      await callFunction('organizer-entry-action', { action: 'edit', registrationId: row.id, fields: changed })
      onDone({ text: `Zapisano — ${`${value.firstName} ${value.lastName}`.trim()}.` })
    } catch (err) {
      if (err.fields) setFields(err.fields)
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="edit-dialog" title="Edytuj dane" subtitle={row.name} busy={busy} onClose={onClose} wide
      error={error && !Object.keys(fields).length ? error : null}
      actions={<button type="button" className={btnPrimary} disabled={busy} onClick={save}>Zapisz</button>}>
      <PersonEditFields idPrefix={ids} value={value} onChange={setValue} fields={fields} busy={busy} formFields={formFields} stored={row} />
    </EntryDialog>
  )
}
