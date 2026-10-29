import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { categoryPreview } from '../../lib/personFormModel.js'
import { countryOptions } from '@registration/countries.js'
import { inputCls, labelCls, sectionCls } from './ui.js'

// The one person form of online registration (spec §2 UI rules: RA2 now; RA3,
// RB1, RB2 and RA7 reuse it). Controlled: `value` is the person, `onChange`
// gets a partial patch. Inputs sit bottom-aligned in a row even when a label
// wraps. `prefill` is what the logged-in person's own profile gave (null for a
// visitor, who gets the „Zaloguj się” offer instead); nobody else is ever
// looked up.

function Field({ id, label, error, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-1.5 justify-end ${className}`}>
      <label htmlFor={id} className={labelCls}>{label}</label>
      {children}
      {error && <p id={`${id}-error`} className="text-apex-red font-sans text-sm">{error}</p>}
    </div>
  )
}

function TextInput({ id, value, onChange, error, ...rest }) {
  return (
    <input id={id} className={`${inputCls} ${error ? 'border-apex-red' : ''}`} value={value ?? ''}
      aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-error` : undefined}
      onChange={(e) => onChange(e.target.value)} {...rest} />
  )
}

const optional = (label, mode) => (mode === 'optional' ? `${label} (opcjonalnie)` : label)

// Nationality (P2-R31): the ISO code is the value, the Polish name the label.
function CountrySelect({ id, value, onChange, error, mode }) {
  const options = useMemo(() => countryOptions('pl'), [])
  return (
    <select id={id} className={`${inputCls} ${error ? 'border-apex-red' : ''}`} value={value ?? ''}
      aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-error` : undefined}
      onChange={(e) => onChange(e.target.value)}>
      <option value="">{mode === 'optional' ? '— nie podaję —' : '— wybierz —'}</option>
      {options.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
    </select>
  )
}

/**
 * @param {{ fields: { city, club, ice, nationality }, value: object, onChange: (patch) => void, errors: Record<string, string>,
 *   competition: object, raceDate: string, reckoning: string, ageGroups: object[], prefill: object|null,
 *   loginHref?: string, codeNote?: string, disabled?: boolean }} p
 */
export default function PersonForm({
  fields, value, onChange, errors = {}, raceDate, reckoning, ageGroups, prefill, loginHref, codeNote, disabled = false,
}) {
  const category = categoryPreview(value, { raceDate, reckoning, ageGroups })
  const set = (key) => (v) => onChange({ [key]: v })
  const today = new Date().toISOString().slice(0, 10)

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-[18px] min-w-0">
      <div className="flex flex-col gap-3">
        <h2 className={sectionCls}>Twoje dane</h2>
        {!prefill && loginHref && (
          <Link to={loginHref} data-testid="login-offer"
            className="flex justify-between items-center gap-3 min-h-12 px-3.5 py-2 border border-apex-border-bright text-apex-text-bright font-sans font-semibold text-base hover:border-apex-yellow-dim">
            <span>Masz konto? Zaloguj się, wypełnimy za Ciebie</span>
            <span className="font-mono text-apex-muted" aria-hidden="true">→</span>
          </Link>
        )}
        <div className="grid grid-cols-2 gap-2.5 items-end">
          <Field id="p-first" label="Imię" error={errors.firstName}>
            <TextInput id="p-first" value={value.firstName} onChange={set('firstName')} error={errors.firstName} autoComplete="given-name" maxLength={100} />
          </Field>
          <Field id="p-last" label="Nazwisko" error={errors.lastName}>
            <TextInput id="p-last" value={value.lastName} onChange={set('lastName')} error={errors.lastName} autoComplete="family-name" maxLength={100} />
          </Field>
        </div>
        <Field id="p-birth" label="Data urodzenia" error={errors.birthDate}>
          <TextInput id="p-birth" type="date" min="1900-01-01" max={today} value={value.birthDate} onChange={set('birthDate')}
            error={errors.birthDate} autoComplete="bday" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span id="p-gender-label" className={labelCls}>Płeć</span>
          <div className="flex gap-2" role="group" aria-labelledby="p-gender-label">
            {[['K', 'Kobieta'], ['M', 'Mężczyzna']].map(([g, label]) => (
              <button key={g} type="button" aria-pressed={value.gender === g} onClick={() => onChange({ gender: g })}
                className={`flex-1 min-h-11 border font-sans font-bold text-[17px] whitespace-nowrap ${value.gender === g
                  ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text bg-apex-surface'}`}>
                {label}
              </button>
            ))}
          </div>
          {errors.gender && <p className="text-apex-red font-sans text-sm">{errors.gender}</p>}
        </div>
        <div className="flex justify-between items-center gap-3 px-3 py-2.5 bg-apex-surface-2 border border-apex-border" data-testid="category-preview">
          <span className={labelCls}>Twoja kategoria</span>
          <span className="font-mono text-xl text-apex-yellow whitespace-nowrap">{category ?? '—'}</span>
        </div>
        {fields.city !== 'off' && (
          <Field id="p-city" label={optional('Miejscowość', fields.city)} error={errors.city}>
            <TextInput id="p-city" value={value.city} onChange={set('city')} error={errors.city} autoComplete="address-level2" maxLength={200} />
          </Field>
        )}
        {fields.club !== 'off' && (
          <Field id="p-club" label={optional('Klub', fields.club)} error={errors.club}>
            <TextInput id="p-club" value={value.club} onChange={set('club')} error={errors.club} maxLength={200} />
          </Field>
        )}
        {fields.nationality !== 'off' && (
          <Field id="p-nationality" label={optional('Narodowość', fields.nationality)} error={errors.nationality}>
            <CountrySelect id="p-nationality" value={value.nationality} onChange={set('nationality')} error={errors.nationality} mode={fields.nationality} />
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className={sectionCls}>Kontakt</h2>
        <Field id="p-email" label="E-mail" error={errors.email}>
          <TextInput id="p-email" type="email" value={value.email} onChange={set('email')} error={errors.email} autoComplete="email" maxLength={254} />
          {codeNote && <span className="font-sans text-sm text-apex-muted">{codeNote}</span>}
        </Field>
        <Field id="p-phone" label="Telefon" error={errors.phone}>
          <TextInput id="p-phone" type="tel" value={value.phone} onChange={set('phone')} error={errors.phone} autoComplete="tel" maxLength={40} />
        </Field>
        {fields.ice !== 'off' && (
          <>
            <span className={`${labelCls} mt-1.5 normal-case tracking-normal font-sans text-sm`}>
              Do kogo dzwonić, gdyby coś Ci się stało na trasie{fields.ice === 'optional' ? ' (opcjonalnie)' : ''}
            </span>
            <div className="grid grid-cols-2 gap-2 items-end">
              <Field id="p-ice-name" label="Imię" error={errors.iceName}>
                <TextInput id="p-ice-name" aria-label="Imię osoby do kontaktu" value={value.iceName} onChange={set('iceName')} error={errors.iceName} maxLength={200} />
              </Field>
              <Field id="p-ice-phone" label="Telefon" error={errors.icePhone}>
                <TextInput id="p-ice-phone" aria-label="Telefon osoby do kontaktu" type="tel" value={value.icePhone} onChange={set('icePhone')} error={errors.icePhone} maxLength={40} />
              </Field>
            </div>
          </>
        )}
      </div>
    </fieldset>
  )
}
