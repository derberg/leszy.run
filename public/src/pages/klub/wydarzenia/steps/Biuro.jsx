import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { validateSection } from '@registration/sections.js'
import { btnGhost, fieldInput, fieldLabel } from '../../settingsUi.js'
import { FieldError, MonoHint, sectionErrors } from '../wizardUi.jsx'

const DraggableMap = lazy(() => import('../../../../components/DraggableMap.jsx'))

const num = (v) => (v == null ? null : Number(v))
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

let rowSeq = 0
// `saved`: the row's last whole value (as loaded, or as last sent). A saved
// row being edited keeps that value on the server until the edit is whole.
const row = (h = {}, saved = null) => ({ key: ++rowSeq, date: h.date ?? '', from: h.from ?? '', to: h.to ?? '', saved })
const savedRow = (h) => row(h, { date: h.date, from: h.from, to: h.to })

const blankRow = (r) => !r.date && !r.from && !r.to

function rowError(r) {
  if (TIME_RE.test(r.from) && TIME_RE.test(r.to) && r.to <= r.from) return 'Godzina zamknięcia musi być po otwarciu.'
  // A new row prefilled with a date only is not an error yet; a row being typed into is.
  const started = r.saved || r.from || r.to
  if (started && !blankRow(r) && !(r.date && TIME_RE.test(r.from) && TIME_RE.test(r.to))) return 'Podaj dzień i obie godziny.'
  return null
}
const complete = (r) => !!r.date && TIME_RE.test(r.from) && TIME_RE.test(r.to) && !rowError(r)

const orNull = (v) => (v === '' ? null : v)

// The office section as save-registration-section takes it. Hours are the
// whole list: a whole row as it is now, a saved row mid-edit as it was last
// saved (never deleted by a half-typed edit), a new unfinished row not at all.
function officeValue(f, rows) {
  return {
    sameAsEvent: f.sameAsEvent,
    address: orNull(f.address),
    notes: orNull(f.notes),
    lat: f.lat,
    lng: f.lng,
    hours: rows.map((r) => (complete(r) ? { date: r.date, from: r.from, to: r.to } : r.saved)).filter(Boolean),
  }
}

// Whole rows become the saved value for later half-edits.
const settle = (rows) => rows.map((r) => (complete(r) ? { ...r, saved: { date: r.date, from: r.from, to: r.to } } : r))

export default function Biuro({ event, queue, saveState, readOnly, reportInvalid }) {
  const s = event.settings
  const [form, setForm] = useState(() => ({
    sameAsEvent: s.officeSameAsEvent ?? true,
    address: s.officeAddress ?? '',
    notes: s.officeNotes ?? '',
    lat: num(s.officeLat),
    lng: num(s.officeLng),
  }))
  const [rows, setRows] = useState(() => (event.officeHours ?? []).map(savedRow))
  const [localErrors, setLocalErrors] = useState({})
  const latest = useRef({ form, rows })
  const errors = { ...sectionErrors(saveState, 'office'), ...localErrors }

  // Input that does not validate yet keeps the organizer on this step (P2-R27).
  const rowProblem = rows.map(rowError).find(Boolean)
  useEffect(() => {
    const e = { ...localErrors, ...(rowProblem ? { hours: rowProblem } : {}) }
    reportInvalid?.('office', Object.keys(e).length ? e : null)
  }, [localErrors, rowProblem, reportInvalid])
  useEffect(() => () => reportInvalid?.('office', null), [reportInvalid])

  function apply(nextForm, rowsIn) {
    const nextRows = settle(rowsIn)
    latest.current = { form: nextForm, rows: nextRows }
    setForm(nextForm)
    setRows(nextRows)
    const value = officeValue(nextForm, nextRows)
    const result = validateSection('office', value, { state: s.state })
    setLocalErrors(result.ok ? {} : result.errors)
    if (result.ok) queue('office', value)
  }

  const setField = (field) => (e) => apply({ ...latest.current.form, [field]: e.target.value }, latest.current.rows)
  const setRow = (key, field) => (e) => apply(latest.current.form,
    latest.current.rows.map((r) => (r.key === key ? { ...r, [field]: e.target.value } : r)))
  const removeRow = (key) => apply(latest.current.form, latest.current.rows.filter((r) => r.key !== key))
  const addRow = () => {
    const last = latest.current.rows.at(-1)
    const rowsNext = [...latest.current.rows, row({ date: last?.date || s.eventDate || '' })]
    latest.current = { ...latest.current, rows: rowsNext }
    setRows(rowsNext)
  }

  function choose(sameAsEvent) {
    const f = latest.current.form
    // The office pin starts where the event's is.
    const pin = !sameAsEvent && f.lat == null ? { lat: num(s.lat), lng: num(s.lng) } : {}
    apply({ ...f, sameAsEvent, ...pin }, latest.current.rows)
  }

  const eventPlace = [s.townLabel, s.placeDetails?.split('\n')[0]].filter(Boolean).join(', ')
  const optClass = (on) => `flex-1 basis-[260px] flex gap-3 items-start p-4 border bg-apex-surface cursor-pointer font-sans text-base text-apex-text-bright ${on ? 'border-apex-yellow-dim' : 'border-apex-border-mid'}`

  return (
    <fieldset disabled={readOnly} className="space-y-8 min-w-0">
      <div className="flex flex-wrap gap-3">
        <label className={optClass(form.sameAsEvent)}>
          <input type="radio" name="office-place" className="w-[18px] h-[18px] mt-0.5 accent-apex-yellow" checked={form.sameAsEvent} onChange={() => choose(true)} />
          <span>
            <strong>To samo miejsce co wydarzenie</strong>
            {eventPlace && <><br /><span className="text-sm text-apex-muted">{eventPlace} · adres i pinezka z kroku 1</span></>}
          </span>
        </label>
        <label className={optClass(!form.sameAsEvent)}>
          <input type="radio" name="office-place" className="w-[18px] h-[18px] mt-0.5 accent-apex-yellow" checked={!form.sameAsEvent} onChange={() => choose(false)} />
          <span><strong>Inne miejsce</strong></span>
        </label>
      </div>

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] items-start">
        <div className="space-y-4 min-w-0">
          {!form.sameAsEvent && (
            <div>
              <label htmlFor="office-address" className={fieldLabel}>Adres</label>
              <input id="office-address" className={fieldInput} value={form.address} onChange={setField('address')} />
              <FieldError message={errors.address} />
            </div>
          )}
          <div>
            <label htmlFor="office-notes" className={fieldLabel}>Uwagi</label>
            <textarea id="office-notes" rows={3} className={`${fieldInput} resize-y`} value={form.notes} onChange={setField('notes')} />
            <FieldError message={errors.notes} />
          </div>
        </div>
        {!form.sameAsEvent && (
          <div className="min-w-0">
            <span className={fieldLabel}>Biuro na mapie</span>
            <Suspense fallback={<div className="h-[200px] border border-apex-border bg-apex-surface" />}>
              <DraggableMap lat={form.lat} lng={form.lng} height={200}
                onChange={(lat, lng) => { if (!readOnly) apply({ ...latest.current.form, lat, lng }, latest.current.rows) }} />
            </Suspense>
          </div>
        )}
      </div>

      <div>
        <span className={fieldLabel}>Godziny otwarcia</span>
        {rows.length > 0 && (
          <div className="space-y-3 mb-3">
            <div className="hidden sm:grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_3rem] gap-2">
              <span className="font-mono text-xs uppercase tracking-wide text-apex-muted">Dzień</span>
              <span className="font-mono text-xs uppercase tracking-wide text-apex-muted">Od</span>
              <span className="font-mono text-xs uppercase tracking-wide text-apex-muted">Do</span>
            </div>
            {rows.map((r, i) => (
              <div key={r.key} data-testid="office-hours-row"
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3rem] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_3rem] gap-2 items-stretch">
                <input type="date" aria-label={`Dzień ${i + 1}`} className={`${fieldInput} px-2 col-span-full sm:col-span-1`} value={r.date} onChange={setRow(r.key, 'date')} />
                <input type="time" aria-label={`Od ${i + 1}`} className={`${fieldInput} px-2`} value={r.from} onChange={setRow(r.key, 'from')} />
                <input type="time" aria-label={`Do ${i + 1}`} className={`${fieldInput} px-2`} value={r.to} onChange={setRow(r.key, 'to')} />
                <button type="button" aria-label="Usuń" className={`${btnGhost} text-base px-0`} onClick={() => removeRow(r.key)}>×</button>
                {rowError(r) && <div className="col-span-full"><FieldError message={rowError(r)} /></div>}
              </div>
            ))}
          </div>
        )}
        <button type="button" className={btnGhost} onClick={addRow}>+ Termin</button>
        <FieldError message={errors.hours ?? errors.date ?? errors.from ?? errors.to} />
        {!rows.length && <MonoHint>Brak terminów</MonoHint>}
      </div>
    </fieldset>
  )
}
