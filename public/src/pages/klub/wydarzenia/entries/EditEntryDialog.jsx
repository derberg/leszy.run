import { useId, useMemo, useState } from 'react'
import { countryOptions } from '@registration/countries.js'
import { callFunction } from '../../../../lib/auth.js'
import { fieldModes } from '../../../../lib/personFormModel.js'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from './EntryDialog.jsx'

// „Edytuj dane” (B3): the person's fields prefilled from the row; only what changed goes to
// organizer-entry-action edit, which runs the form's own validatePerson and answers a 422 with
// `fields`, each shown under its input. The e-mail is never editable. Miejscowość, Klub, the
// emergency contact and Narodowość follow the event's form switches (organizer_edit_registration
// refuses a value in a field switched off), and a field switched off still shows while the entry
// holds a value in it. Until closes_at only (the ⋯ hides it after).

// Fields a person may leave empty: an empty one is sent as null. The rest are required.
const OPTIONAL = new Set(['city', 'club', 'iceName', 'icePhone', 'nationality'])

const LABELS = {
  firstName: 'Imię',
  lastName: 'Nazwisko',
  birthDate: 'Data urodzenia',
  phone: 'Telefon',
  city: 'Miejscowość',
  club: 'Klub',
  iceName: 'Kontakt w razie wypadku — imię',
  icePhone: 'Kontakt w razie wypadku — telefon',
  nationality: 'Narodowość',
}

const initial = (row) => ({
  firstName: row.firstName ?? '', lastName: row.lastName ?? '', birthDate: row.birthDate ?? '', gender: row.gender ?? '',
  phone: row.phone ?? '', city: row.city ?? '', club: row.club ?? '', iceName: row.iceName ?? '', icePhone: row.icePhone ?? '',
  nationality: row.nationality ?? '',
})

/** The changed fields as the server takes them: trimmed, an emptied optional field as null. */
export function changedFields(before, after) {
  const out = {}
  for (const key of Object.keys(after)) {
    const value = after[key].trim()
    if (value === before[key].trim()) continue
    out[key] = value === '' && OPTIONAL.has(key) ? null : value
  }
  return out
}

export default function EditEntryDialog({ row, formFields = null, onClose, onDone, onFailed }) {
  const ids = useId()
  const [start] = useState(() => initial(row))
  const [value, setValue] = useState(start)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const modes = fieldModes(formFields)
  const shown = {
    city: modes.city !== 'off' || !!row.city,
    club: modes.club !== 'off' || !!row.club,
    ice: modes.ice !== 'off' || !!row.iceName || !!row.icePhone,
    nationality: modes.nationality !== 'off' || !!row.nationality,
  }
  const countries = useMemo(() => (shown.nationality ? countryOptions('pl') : []), [shown.nationality])
  const id = (key) => `${ids}-${key}`
  const set = (key) => (e) => setValue({ ...value, [key]: e.target.value })

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

  const input = (key, props = {}) => (
    <div className="min-w-0">
      <label htmlFor={id(key)} className={dialogLabel}>{LABELS[key]}</label>
      <input id={id(key)} value={value[key]} onChange={set(key)} disabled={busy}
        aria-invalid={fields[key] ? 'true' : undefined} aria-describedby={fields[key] ? `${id(key)}-err` : undefined}
        className={`${dialogInput} ${fields[key] ? 'border-apex-red' : ''}`} {...props} />
      <FieldMessage id={`${id(key)}-err`} message={fields[key]} />
    </div>
  )

  return (
    <EntryDialog testId="edit-dialog" title="Edytuj dane" subtitle={row.name} busy={busy} onClose={onClose} wide
      error={error && !Object.keys(fields).length ? error : null}
      actions={<button type="button" className={btnPrimary} disabled={busy} onClick={save}>Zapisz</button>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {input('firstName', { autoComplete: 'off', maxLength: 100 })}
        {input('lastName', { autoComplete: 'off', maxLength: 100 })}
        {input('birthDate', { type: 'date', min: '1900-01-01' })}
        <div className="min-w-0">
          <span id={id('gender')} className={dialogLabel}>Płeć</span>
          <div role="group" aria-labelledby={id('gender')} className="flex gap-2">
            {[['K', 'Kobieta'], ['M', 'Mężczyzna']].map(([g, label]) => (
              <button key={g} type="button" aria-pressed={value.gender === g} disabled={busy} onClick={() => setValue({ ...value, gender: g })}
                className={`flex-1 min-h-10 border font-sans font-bold text-base whitespace-nowrap ${value.gender === g
                  ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text bg-apex-bg'}`}>
                {label}
              </button>
            ))}
          </div>
          <FieldMessage message={fields.gender} />
        </div>
        {input('phone', { type: 'tel', maxLength: 40 })}
        {shown.city && input('city', { maxLength: 200 })}
        {shown.club && input('club', { maxLength: 200 })}
        {shown.nationality && (
          <div className="min-w-0">
            <label htmlFor={id('nationality')} className={dialogLabel}>{LABELS.nationality}</label>
            <select id={id('nationality')} value={value.nationality} onChange={set('nationality')} disabled={busy} className={dialogInput}>
              <option value="">—</option>
              {countries.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
            </select>
            <FieldMessage message={fields.nationality} />
          </div>
        )}
        {shown.ice && input('iceName', { maxLength: 200 })}
        {shown.ice && input('icePhone', { type: 'tel', maxLength: 40 })}
      </div>
    </EntryDialog>
  )
}
