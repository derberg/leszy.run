import { useMemo } from 'react'
import { countryOptions } from '@registration/countries.js'
import { fieldModes } from '../../lib/personFormModel.js'
import { FieldMessage, dialogInput, dialogLabel } from '../../pages/klub/wydarzenia/entries/EntryDialog.jsx'

// A registered person's editable fields, prefilled: the club's „Edytuj dane” (B3, EditEntryDialog,
// with the names) and the runner's own „Popraw dane” (Moje zapisy, EditMyDataDialog, without them:
// names and the e-mail stay with the club). The e-mail is never here. Miejscowość, Klub, the
// emergency contact and Narodowość follow the event's form switches; a field switched off still
// shows while the entry holds a value in it. Only what changed is sent (changedFields); the server
// runs the form's validatePerson and answers a 422 with `fields`, each shown under its input.

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

/** The form's starting values from a person ({ firstName, lastName, birthDate, gender, … }). */
export function initialPerson(p, { names = true } = {}) {
  const out = {
    birthDate: p.birthDate ?? '', gender: p.gender ?? '', phone: p.phone ?? '', city: p.city ?? '', club: p.club ?? '',
    iceName: p.iceName ?? '', icePhone: p.icePhone ?? '', nationality: p.nationality ?? '',
  }
  return names ? { firstName: p.firstName ?? '', lastName: p.lastName ?? '', ...out } : out
}

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

/**
 * @param {{ idPrefix: string, value: object, onChange: (v: object) => void, fields: object, busy: boolean,
 *   formFields: object|null, stored: object }} p
 * `value` holds firstName/lastName only when the names are editable. `stored`: the person as saved,
 * so a field switched off keeps showing while it holds a value.
 */
export default function PersonEditFields({ idPrefix, value, onChange, fields, busy, formFields, stored }) {
  const modes = fieldModes(formFields)
  const shown = {
    city: modes.city !== 'off' || !!stored.city,
    club: modes.club !== 'off' || !!stored.club,
    ice: modes.ice !== 'off' || !!stored.iceName || !!stored.icePhone,
    nationality: modes.nationality !== 'off' || !!stored.nationality,
  }
  const countries = useMemo(() => (shown.nationality ? countryOptions('pl') : []), [shown.nationality])
  const id = (key) => `${idPrefix}-${key}`
  const set = (key) => (e) => onChange({ ...value, [key]: e.target.value })
  const names = 'firstName' in value

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
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {names && input('firstName', { autoComplete: 'off', maxLength: 100 })}
      {names && input('lastName', { autoComplete: 'off', maxLength: 100 })}
      {input('birthDate', { type: 'date', min: '1900-01-01' })}
      <div className="min-w-0">
        <span id={id('gender')} className={dialogLabel}>Płeć</span>
        <div role="group" aria-labelledby={id('gender')} className="flex gap-2">
          {[['K', 'Kobieta'], ['M', 'Mężczyzna']].map(([g, label]) => (
            <button key={g} type="button" aria-pressed={value.gender === g} disabled={busy} onClick={() => onChange({ ...value, gender: g })}
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
  )
}
