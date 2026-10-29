import { useEffect, useRef, useState } from 'react'
import { validateSection } from '@registration/sections.js'
import { fieldInput } from '../../settingsUi.js'
import { FieldError, Lock, sectionErrors } from '../wizardUi.jsx'

// A4b: who times the race. LESZY.RUN / another company (name and result
// links) / no timing. The mode cannot change after publish.

const MODES = [
  { value: 'leszyrun', label: 'LESZY.RUN' },
  { value: 'external', label: 'Inna firma' },
  { value: 'none', label: 'Bez pomiaru' },
]

const orNull = (v) => (v.trim() === '' ? null : v.trim())

export default function Pomiar({ event, queue, saveState, readOnly, reportInvalid }) {
  const s = event.settings
  const published = s.state !== 'draft'
  const [form, setForm] = useState(() => ({
    timingMode: s.timingMode ?? 'leszyrun',
    timingCompany: s.timingCompany ?? '',
    resultsUrl: s.resultsUrl ?? '',
    liveResultsUrl: s.liveResultsUrl ?? '',
  }))
  const [localErrors, setLocalErrors] = useState({})
  const latest = useRef(form)
  const errors = { ...sectionErrors(saveState, 'timing'), ...localErrors }

  function apply(next) {
    latest.current = next
    setForm(next)
    const value = {
      ...(published ? {} : { timingMode: next.timingMode }),
      timingCompany: orNull(next.timingCompany),
      resultsUrl: orNull(next.resultsUrl),
      liveResultsUrl: orNull(next.liveResultsUrl),
    }
    // A link still being typed waits; the rest saves meanwhile.
    let result = validateSection('timing', value, { state: s.state })
    const waiting = {}
    for (const field of ['resultsUrl', 'liveResultsUrl']) {
      if (!result.ok && result.errors[field]) {
        waiting[field] = result.errors[field]
        delete value[field]
        result = validateSection('timing', value, { state: s.state })
      }
    }
    setLocalErrors({ ...(result.ok ? {} : result.errors), ...waiting })
    if (result.ok) queue('timing', value)
  }

  // Input that does not validate yet keeps the organizer on this step (P2-R27).
  useEffect(() => {
    reportInvalid?.('timing', Object.keys(localErrors).length ? localErrors : null)
  }, [localErrors, reportInvalid])
  useEffect(() => () => reportInvalid?.('timing', null), [reportInvalid])

  const set = (field) => (e) => apply({ ...latest.current, [field]: e.target.value })
  const label = 'block font-mono text-xs uppercase tracking-wide text-apex-muted mb-1.5'

  return (
    <fieldset disabled={readOnly} className="space-y-6 min-w-0">
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Pomiar czasu">
        {MODES.map((m) => {
          const on = form.timingMode === m.value
          return (
            <label key={m.value} className={`flex-1 basis-[240px] flex gap-3 items-center p-4 border font-sans text-[17px] text-apex-text-bright ${
              on ? 'border-apex-yellow bg-apex-surface-2' : 'border-apex-border-mid bg-apex-surface'} ${published && !on ? 'opacity-60' : ''}`}>
              <input type="radio" name="timing-mode" className="w-[18px] h-[18px] accent-apex-yellow" checked={on}
                disabled={published} onChange={() => apply({ ...latest.current, timingMode: m.value })} />
              <strong>{m.label}</strong>
              {published && on && <Lock title="Pomiaru czasu nie można zmienić po publikacji" />}
            </label>
          )
        })}
      </div>
      <FieldError message={errors.timingMode} />

      {form.timingMode === 'external' && (
        <section className="border border-apex-yellow bg-apex-surface p-4 sm:p-5 grid gap-3.5 grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] max-w-[900px] items-end">
          <div>
            <label htmlFor="timing-company" className={label}>Firma</label>
            <input id="timing-company" className={fieldInput} value={form.timingCompany} onChange={set('timingCompany')} />
            <FieldError message={errors.timingCompany} />
          </div>
          <div>
            <label htmlFor="timing-results" className={label}>Link do wyników · można dodać po zawodach</label>
            <input id="timing-results" className={fieldInput} placeholder="https://" value={form.resultsUrl} onChange={set('resultsUrl')} />
            <FieldError message={errors.resultsUrl} />
          </div>
          <div>
            <label htmlFor="timing-live" className={label}>Link do wyników na żywo · opcjonalnie</label>
            <input id="timing-live" className={fieldInput} placeholder="https://" value={form.liveResultsUrl} onChange={set('liveResultsUrl')} />
            <FieldError message={errors.liveResultsUrl} />
          </div>
        </section>
      )}
    </fieldset>
  )
}
