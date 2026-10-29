import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { validateSection } from '@registration/sections.js'
import { reconcileRowIds } from '../../../../lib/categoryRows.js'
import { btnGhost } from '../../settingsUi.js'
import { FieldError, Seg, Soon, cardTitle, cellInput, monoLabel, sectionErrors } from '../wizardUi.jsx'

// A5: which runner fields the form asks for (Wymagane / Opcjonalne / Brak)
// and the consents. Name, birth date, gender, e-mail, guardian data, the
// regulamin and the data information are always there. Every added consent
// is its own required checkbox, unticked by default.

const FIELDS = [
  { key: 'phone', label: 'Telefon' },
  { key: 'city', label: 'Miejscowość' },
  { key: 'club', label: 'Klub / drużyna' },
  { key: 'ice', label: 'Kontakt w nagłych wypadkach' },
]
const MODES = [['required', 'Wymagane'], ['optional', 'Opcjonalne'], ['off', 'Brak']]

const PRESETS = [
  { label: 'Start na własną odpowiedzialność', text: 'Startuję na własną odpowiedzialność.' },
  { label: 'Publikacja wizerunku', text: 'Zgadzam się na publikację mojego wizerunku w relacjach z zawodów.' },
  { label: 'Zgoda opiekuna · dzieci', text: 'Jako opiekun zgadzam się na udział dziecka w zawodach.' },
]

let rowSeq = 0
const consentRow = (k = {}) => ({ key: ++rowSeq, id: k.id ?? null, text: k.text ?? '', saved: k.text ?? null })

// Whole consents only; a saved one being retyped keeps its last text.
function consentsValue(rows) {
  const items = []
  const keys = []
  for (const r of rows) {
    const text = r.text.trim() || (r.id ? r.saved : null)
    if (!text) continue
    items.push({ ...(r.id ? { id: r.id } : {}), text })
    keys.push(r.key)
  }
  return { items, keys }
}

function Row({ children, right }) {
  return (
    <div className="flex flex-wrap justify-between items-center gap-3 min-h-[46px] px-3.5 py-1.5 border-b border-apex-border text-[17px] text-apex-text-bright">
      <span className="min-w-0">{children}</span>
      {right}
    </div>
  )
}
const Always = ({ children = 'ZAWSZE' }) => <span className="font-mono text-xs text-apex-muted">{children}</span>

export default function Formularz({ event, queue, saveState, readOnly, onSaved, previewHref, reportInvalid }) {
  const s = event.settings
  const [fields, setFields] = useState(() => ({ phone: 'optional', city: 'optional', club: 'optional', ice: 'optional', ...(s.formFields ?? {}) }))
  const [rows, setRows] = useState(() => (event.consents ?? []).filter((k) => k.kind === 'custom').map(consentRow))
  const [localError, setLocalError] = useState(null)
  const latest = useRef({ fields, rows })
  const sentKeys = useRef([])
  const serverErrors = sectionErrors(saveState, 'form')

  // Ids from the latest answer only: a consent it left out was deleted.
  useEffect(() => onSaved('form', (data) => {
    const next = reconcileRowIds(latest.current.rows, sentKeys.current, data?.consentIds)
    if (next === latest.current.rows) return
    latest.current = { ...latest.current, rows: next }
    setRows(next)
  }), [onSaved])

  // Pure; what was sent is recorded only when the save starts (I2).
  const build = () => {
    const { items, keys } = consentsValue(latest.current.rows)
    return { value: { formFields: latest.current.fields, consents: items }, keys }
  }
  const sectionNow = () => {
    const { value, keys } = build()
    sentKeys.current = keys
    return value
  }

  function apply(next) {
    latest.current = { ...latest.current, ...next }
    if (next.fields) setFields(next.fields)
    if (next.rows) setRows(next.rows)
    const check = validateSection('form', build().value, { state: s.state })
    setLocalError(check.ok ? null : Object.values(check.errors).join(' '))
    if (check.ok) queue('form', sectionNow)
  }

  useEffect(() => {
    reportInvalid?.('form', localError ? { consents: localError } : null)
  }, [localError, reportInvalid])
  useEffect(() => () => reportInvalid?.('form', null), [reportInvalid])

  const setMode = (key, mode) => apply({ fields: { ...latest.current.fields, [key]: mode } })
  const settle = (list) => list.map((r) => (r.text.trim() ? { ...r, saved: r.text.trim() } : r))
  const setText = (key) => (e) => apply({ rows: settle(latest.current.rows.map((r) => (r.key === key ? { ...r, text: e.target.value } : r))) })
  const remove = (key) => apply({ rows: latest.current.rows.filter((r) => r.key !== key) })
  const addCustom = () => {
    const next = [...latest.current.rows, consentRow()]
    latest.current = { ...latest.current, rows: next }
    setRows(next)
  }
  const presetOn = (p) => rows.some((r) => r.text.trim() === p.text)
  const togglePreset = (p, on) => {
    const cur = latest.current.rows
    if (on && !cur.some((r) => r.text.trim() === p.text)) apply({ rows: [...cur, consentRow({ text: p.text })] })
    if (!on) apply({ rows: cur.filter((r) => r.text.trim() !== p.text) })
  }
  const customRows = rows.filter((r) => !PRESETS.some((p) => p.text === r.text.trim()))

  const panel = 'flex-1 border border-apex-border-mid bg-apex-surface min-w-0'
  return (
    <div className="space-y-5 min-w-0">
      {previewHref && (
        <div className="flex justify-end -mt-2">
          <Link to={previewHref} className={`${btnGhost} no-underline inline-block`}>Podgląd jako biegacz →</Link>
        </div>
      )}
      <fieldset disabled={readOnly} className="flex flex-wrap gap-5 min-w-0">
        <section className={`${panel} basis-[480px]`} data-testid="form-fields">
          <div className="p-3.5"><h2 className={cardTitle}>Dane zawodnika</h2></div>
          <Row right={<Always />}>Imię i nazwisko</Row>
          <Row right={<Always>ZAWSZE · KATEGORIA</Always>}>Data urodzenia</Row>
          <Row right={<Always>ZAWSZE · KATEGORIA</Always>}>Płeć</Row>
          <Row right={<Always>ZAWSZE · NA NIEGO IDZIE KOD POTWIERDZAJĄCY</Always>}>E-mail</Row>
          {FIELDS.map((f) => (
            <Row key={f.key} right={(
              <span className="flex gap-1" role="group" aria-label={f.label}>
                {MODES.map(([mode, label]) => (
                  <Seg key={mode} on={fields[f.key] === mode} onClick={() => setMode(f.key, mode)}>{label}</Seg>
                ))}
              </span>
            )}>{f.label}</Row>
          ))}
          <Row right={<Always />}>Dane opiekuna · zawodnik niepełnoletni</Row>
          <div className="p-3.5 flex items-center gap-2">
            <button type="button" className={btnGhost} disabled>+ Własne pytanie</button>
            <Soon />
          </div>
        </section>

        <section className={`${panel} basis-[380px]`} data-testid="form-consents">
          <div className="p-3.5"><h2 className={cardTitle}>Zgody</h2></div>
          <Row right={<Always />}>Akceptacja regulaminu zawodów</Row>
          <Row right={<Always />}>Informacja o danych osobowych</Row>
          <div className="px-3.5 pt-2 pb-1"><span className={monoLabel}>Dodatkowe zgody · osobny checkbox, wymagany do zapisu</span></div>
          {PRESETS.map((p) => (
            <Row key={p.text} right={(
              <span className="flex gap-1" role="group" aria-label={p.label}>
                <Seg on={presetOn(p)} onClick={() => togglePreset(p, true)}>Dodaj</Seg>
                <Seg on={!presetOn(p)} onClick={() => togglePreset(p, false)}>Nie</Seg>
              </span>
            )}>{p.label}</Row>
          ))}
          {customRows.map((r, i) => (
            <div key={r.key} className="flex gap-2 items-start px-3.5 py-2 border-b border-apex-border" data-testid="custom-consent">
              <textarea aria-label={`Treść zgody ${i + 1}`} rows={2} className={`${cellInput} w-full h-auto py-2 resize-y`} value={r.text} onChange={setText(r.key)} />
              <button type="button" aria-label={`Usuń zgodę ${i + 1}`} className={`${btnGhost} text-base px-3`} onClick={() => remove(r.key)}>×</button>
            </div>
          ))}
          <div className="p-3.5"><button type="button" className={btnGhost} onClick={addCustom}>+ Własna zgoda</button></div>
          <div className="mx-3.5 mb-3.5 pt-2.5 border-t border-apex-border text-sm text-apex-muted leading-snug">
            <span className="font-mono text-xs">ⓘ</span> Zalecamy, by regulamin zawodów obejmował start na własną odpowiedzialność, publikację wizerunku i udział dzieci za zgodą opiekuna.
          </div>
        </section>
      </fieldset>
      <FieldError message={localError ?? (Object.keys(serverErrors).length ? Object.values(serverErrors).join(' ') : null)} />
    </div>
  )
}
