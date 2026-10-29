import { useEffect, useRef, useState } from 'react'
import { validateSection } from '@registration/sections.js'
import {
  ageGroupsValue, ageModeOf, ageTemplate, ageTemplateFrom, countLabel, kidsGroupsValue, kidsModeOf, kidsRow, kidsRowsFor,
} from '../../../../lib/categoryRows.js'
import { btnGhost } from '../../settingsUi.js'
import {
  FieldError, Seg, cardClass, cardTitle, cellInput, monoLabel, sectionErrors, tdClass, thClass,
} from '../wizardUi.jsx'

// A4: Open K/M always; age classes (co 10 / co 5 lat / własne) applied to
// every adult competition; birth-year groups for each kids competition. The
// categories section is saved whole: reckoning, age groups and kids groups.

const KONKURENCJE = ['KONKURENCJA', 'KONKURENCJE', 'KONKURENCJI']
const KLASYFIKACJE = ['KLASYFIKACJA', 'KLASYFIKACJE', 'KLASYFIKACJI']
const reckoningTip = (year) => `W dniu zawodów: ukończone lata w dniu startu. Rocznikiem: ${year} minus rok urodzenia, więc wszyscy z jednego rocznika trafiają do tej samej kategorii, niezależnie od daty urodzin.`

const groupKey = (categoryId, gender, label) => `${categoryId}|${gender}|${label}`
const toInt = (v) => (/^\d+$/.test(String(v).trim()) ? Number(v) : null)

function ChoiceCard({ title, text, added, tone, onClick, testId }) {
  const border = added ? (tone === 'cyan' ? 'border-apex-cyan' : 'border-apex-yellow') : 'border-apex-border-mid hover:border-apex-border-bright'
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className={`flex-1 basis-[260px] text-left border ${border} bg-apex-surface px-4 py-3.5 flex flex-col gap-1 font-sans`}>
      <span className="flex justify-between gap-2.5 w-full">
        <span className="text-lg font-bold text-apex-text-bright">{title}</span>
        {added && <span className={`font-mono text-xs ${tone === 'cyan' ? 'text-apex-cyan' : 'text-apex-yellow'}`}>✓ DODANE</span>}
      </span>
      <span className="text-[15px] text-apex-muted leading-snug">{text}</span>
    </button>
  )
}

function ConfirmRemove({ text, onCancel, onConfirm }) {
  return (
    <div role="alertdialog" aria-label={text} className="border border-apex-red bg-apex-surface-2 px-3.5 py-3 flex flex-wrap justify-between items-center gap-2.5">
      <span className="text-base text-apex-text-bright">{text}</span>
      <span className="flex gap-1.5">
        <Seg onClick={onCancel}>Anuluj</Seg>
        <button type="button" onClick={onConfirm} className="whitespace-nowrap min-h-9 px-3 border border-apex-red bg-apex-red text-apex-ink font-sans font-bold text-sm">Usuń</button>
      </span>
    </div>
  )
}

export default function Kategorie({ event, queue, saveState, readOnly, onSaved }) {
  const settings = event.settings
  const comps = (event.competitions ?? []).map((c) => ({
    categoryId: c.categoryId, name: c.name, isKids: !!c.isKids, hidden: !!c.hiddenAt, minAge: c.minAge, maxAge: c.maxAge,
  }))
  const adults = comps.filter((c) => !c.isKids && !c.hidden)
  const kidsComps = comps.filter((c) => c.isKids && !c.hidden)

  const [reckoning, setReckoning] = useState(settings.ageReckoning ?? 'race_day')
  const [template, setTemplate] = useState(() => ageTemplateFrom(event.ageGroups))
  const [ageMode, setAgeMode] = useState(() => ageModeOf(ageTemplateFrom(event.ageGroups)))
  const [kids, setKids] = useState(() => Object.fromEntries(kidsComps.map((c) => [
    c.categoryId, (event.kidsGroups ?? []).filter((g) => g.categoryId === c.categoryId).map(kidsRow),
  ])))
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [confirm, setConfirm] = useState(null) // 'age' | categoryId
  const [localError, setLocalError] = useState(null)
  const latest = useRef({ reckoning, template, kids })
  const idOf = useRef(new Map((event.ageGroups ?? []).map((g) => [groupKey(g.categoryId, g.gender, g.label), g.id])))
  const sent = useRef({ age: [], kids: [] })
  const serverErrors = sectionErrors(saveState, 'categories')

  useEffect(() => onSaved('categories', (data) => {
    ;(data?.ageGroupIds ?? []).forEach((id, i) => { if (sent.current.age[i]) idOf.current.set(sent.current.age[i], id) })
    const ids = new Map(sent.current.kids.map((key, i) => [key, data?.kidsGroupIds?.[i]]))
    const next = Object.fromEntries(Object.entries(latest.current.kids).map(([cid, rows]) => [
      cid, rows.map((r) => (!r.id && ids.get(r.key) ? { ...r, id: ids.get(r.key) } : r)),
    ]))
    latest.current = { ...latest.current, kids: next }
    setKids(next)
  }), [onSaved])

  // Read when the save starts: ids from the previous save go along.
  function sectionNow() {
    const { reckoning: r, template: t, kids: k } = latest.current
    const ageGroups = ageGroupsValue(t, adults, idOf.current)
    const kidsGroups = []
    const kidsKeys = []
    for (const c of kidsComps) {
      const { items, sentKeys } = kidsGroupsValue(c.categoryId, k[c.categoryId] ?? [])
      kidsGroups.push(...items)
      kidsKeys.push(...sentKeys)
    }
    sent.current = { age: ageGroups.map((g) => groupKey(g.categoryId, g.gender, g.label)), kids: kidsKeys }
    return { ageReckoning: r, ageGroups, kidsGroups }
  }

  function apply(next) {
    latest.current = { ...latest.current, ...next }
    if ('reckoning' in next) setReckoning(next.reckoning)
    if ('template' in next) setTemplate(next.template)
    if ('kids' in next) setKids(next.kids)
    const check = validateSection('categories', sectionNow(), { state: settings.state })
    setLocalError(check.ok ? null : Object.values(check.errors).join(' '))
    if (check.ok) queue('categories', sectionNow)
  }

  // ---- age classes
  function chooseAgeMode(mode) {
    const from = ageMode?.from ?? 16
    const to = ageMode?.to ?? 60
    if (mode === 'custom') {
      setAgeMode({ mode, from, to })
      return
    }
    setAgeMode({ mode, from, to })
    apply({ template: ageTemplate(mode, from, to) })
  }
  function setRange(field, value) {
    const n = toInt(value)
    const nextMode = { ...ageMode, [field]: value === '' ? '' : n ?? ageMode[field] }
    setAgeMode(nextMode)
    if (Number.isInteger(nextMode.from) && Number.isInteger(nextMode.to) && nextMode.to > nextMode.from) {
      apply({ template: ageTemplate(nextMode.mode, nextMode.from, nextMode.to) })
    }
  }
  function removeChip(g) {
    setAgeMode((m) => ({ ...m, mode: 'custom' }))
    apply({ template: latest.current.template.filter((t) => !(t.gender === g.gender && t.label === g.label)) })
  }
  function addCustom() {
    const from = toInt(custom.from)
    const to = custom.to === '' ? null : toInt(custom.to)
    if (from == null || (custom.to !== '' && (to == null || to < from))) return
    const added = ['K', 'M'].map((gender) => ({ gender, label: `${gender}${from}${to == null ? '+' : `–${to}`}`, minAge: from, maxAge: to }))
    const keep = latest.current.template.filter((t) => !added.some((a) => a.gender === t.gender && a.label === t.label))
    apply({ template: [...keep, ...added].sort((a, b) => a.gender.localeCompare(b.gender) || a.minAge - b.minAge) })
    setCustom({ from: '', to: '' })
  }
  function addAgeClasses() {
    if (latest.current.template.length) return
    setAgeMode({ mode: 'step10', from: 16, to: 60 })
    apply({ template: ageTemplate('step10', 16, 60) })
  }
  function removeAgeClasses() {
    setConfirm(null)
    setAgeMode(null)
    apply({ template: [] })
  }

  // ---- kids groups
  const setKidsRows = (cid, rows) => apply({ kids: { ...latest.current.kids, [cid]: rows } })
  function addKidsGroups() {
    const next = { ...latest.current.kids }
    for (const c of kidsComps) if (!next[c.categoryId]?.length) next[c.categoryId] = kidsRowsFor(c, settings.eventDate, 'step2')
    apply({ kids: next })
  }
  const setKidsField = (cid, key, field, parse = (v) => v) => (e) => setKidsRows(cid,
    latest.current.kids[cid].map((r) => (r.key === key ? { ...r, [field]: parse(e.target.value) } : r)))
  const yearOf = (v) => (v === '' ? null : toInt(v))
  const genderOf = (v) => (v === '' ? null : v)

  const ageAdded = template.length > 0
  const kidsAdded = kidsComps.some((c) => kids[c.categoryId]?.length)
  const year = Number(String(settings.eventDate ?? '').slice(0, 4)) || new Date().getFullYear()
  const label = 'block font-mono text-xs uppercase tracking-wide text-apex-muted mb-1.5'

  return (
    <fieldset disabled={readOnly} className="space-y-5 min-w-0">
      <section className={cardClass}>
        <h2 className={cardTitle}>Open</h2>
        <div className="flex gap-1.5 flex-wrap">
          <span className="font-mono text-sm px-2.5 py-1.5 border border-apex-border-bright text-apex-text-bright">K open</span>
          <span className="font-mono text-sm px-2.5 py-1.5 border border-apex-border-bright text-apex-text-bright">M open</span>
        </div>
        <span className="font-mono text-[13px] text-apex-muted">W KAŻDEJ KONKURENCJI · ZAWSZE</span>
      </section>

      <div className="flex flex-wrap gap-2.5">
        <ChoiceCard title="Kategorie wiekowe" text="Np. K30–39, M40–49. Przydział z daty urodzenia, obok open."
          added={ageAdded} onClick={addAgeClasses} testId="add-age-classes" />
        {kidsComps.length > 0 && (
          <ChoiceCard title="Grupy dzieci" text="Bieg dzieci podzielony na roczniki, każdy z własnym dystansem."
            added={kidsAdded} tone="cyan" onClick={addKidsGroups} testId="add-kids-groups" />
        )}
      </div>

      {(ageAdded || ageMode) && (
        <section className={cardClass} data-testid="age-classes">
          <div className="flex flex-wrap justify-between items-center gap-2.5">
            <h2 className={cardTitle}>Kategorie wiekowe</h2>
            <div className="flex gap-1.5 flex-wrap">
              <Seg on={ageMode?.mode === 'step10'} onClick={() => chooseAgeMode('step10')}>Co 10 lat</Seg>
              <Seg on={ageMode?.mode === 'step5'} onClick={() => chooseAgeMode('step5')}>Co 5 lat</Seg>
              <Seg on={ageMode?.mode === 'custom'} onClick={() => chooseAgeMode('custom')}>Własne</Seg>
              <Seg className="!border-apex-red !text-apex-red" onClick={() => setConfirm('age')}>Usuń</Seg>
            </div>
          </div>
          {confirm === 'age' && (
            <ConfirmRemove text="Usunąć kategorie wiekowe? Ich ustawienia przepadną." onCancel={() => setConfirm(null)} onConfirm={removeAgeClasses} />
          )}
          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] items-end">
            <div>
              <label htmlFor="age-reckoning" className={`${label} flex items-center gap-1.5`}>
                Wiek liczony
                <span tabIndex={0} title={reckoningTip(year)} aria-label={reckoningTip(year)}
                  className="inline-flex items-center justify-center w-[18px] h-[18px] border border-apex-border-bright text-[11px] normal-case cursor-help">?</span>
              </label>
              <select id="age-reckoning" className={`${cellInput} w-full`} value={reckoning} onChange={(e) => apply({ reckoning: e.target.value })}>
                <option value="race_day">w dniu zawodów</option>
                <option value="year_end">rocznikiem ({year} − rok ur.)</option>
              </select>
            </div>
            {ageMode?.mode !== 'custom' && (
              <>
                <div>
                  <label htmlFor="age-from" className={label}>Pierwsza kategoria od</label>
                  <input id="age-from" inputMode="numeric" className={`${cellInput} w-full`} value={ageMode?.from ?? ''} onChange={(e) => setRange('from', e.target.value)} />
                </div>
                <div>
                  <label htmlFor="age-to" className={label}>Ostatnia</label>
                  <div className="flex items-center gap-1">
                    <input id="age-to" inputMode="numeric" className={`${cellInput} w-full`} value={ageMode?.to ?? ''} onChange={(e) => setRange('to', e.target.value)} />
                    <span className="font-mono text-apex-muted">+</span>
                  </div>
                </div>
              </>
            )}
            {ageMode?.mode === 'custom' && (
              <div className="flex items-end gap-1.5">
                <div>
                  <label htmlFor="age-custom-from" className={label}>Od</label>
                  <input id="age-custom-from" inputMode="numeric" className={`${cellInput} w-[70px]`} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="age-custom-to" className={label}>Do</label>
                  <input id="age-custom-to" inputMode="numeric" className={`${cellInput} w-[70px]`} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
                </div>
                <button type="button" className={`${btnGhost} h-10`} onClick={addCustom}>+ Kategoria</button>
              </div>
            )}
          </div>
          <div className="flex gap-1.5 flex-wrap" data-testid="age-chips">
            {template.map((g) => (
              <span key={`${g.gender}${g.label}`} className="inline-flex items-center font-mono text-sm pl-2.5 pr-1 py-1 border border-apex-border-bright text-apex-text-bright">
                {g.label}
                <button type="button" aria-label={`Usuń ${g.label}`} onClick={() => removeChip(g)} className="ml-1.5 px-1 text-apex-muted hover:text-apex-red">×</button>
              </span>
            ))}
          </div>
          <span className="font-mono text-[13px] text-apex-muted" data-testid="age-count">
            × {countLabel(adults.length, KONKURENCJE)} = {countLabel(template.length * adults.length, KLASYFIKACJE)}
          </span>
        </section>
      )}

      {kidsComps.filter((c) => kids[c.categoryId]?.length || confirm === c.categoryId).map((c) => {
        const rows = kids[c.categoryId] ?? []
        const mode = kidsModeOf(rows)
        return (
          <section key={c.categoryId} className={`${cardClass} !border-apex-cyan`} data-testid="kids-groups">
            <div className="flex flex-wrap justify-between items-center gap-2.5">
              <h2 className={cardTitle}>{c.name || 'Dzieci'} · grupy roczników</h2>
              <div className="flex gap-1.5 flex-wrap">
                <Seg on={mode === 'step2'} onClick={() => setKidsRows(c.categoryId, kidsRowsFor(c, settings.eventDate, 'step2'))}>Co 2 roczniki</Seg>
                <Seg on={mode === 'step1'} onClick={() => setKidsRows(c.categoryId, kidsRowsFor(c, settings.eventDate, 'step1'))}>Co rocznik</Seg>
                <Seg on={mode === 'custom'} onClick={() => setKidsRows(c.categoryId, [...rows, kidsRow()])}>Własne</Seg>
                <Seg className="!border-apex-red !text-apex-red" onClick={() => setConfirm(c.categoryId)}>Usuń</Seg>
              </div>
            </div>
            {confirm === c.categoryId && (
              <ConfirmRemove text="Usunąć grupy dzieci? Ich ustawienia przepadną." onCancel={() => setConfirm(null)}
                onConfirm={() => { setConfirm(null); setKidsRows(c.categoryId, []) }} />
            )}
            <div className="relative overflow-x-auto">
              <table className="w-full border-collapse min-w-[600px]">
                <thead><tr>
                  <th className={thClass}>Grupa</th><th className={thClass}>Roczniki</th>
                  <th className={thClass}>Dystans</th><th className={thClass}>Płeć</th><th className={thClass}><span className="sr-only">Akcje</span></th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.key} data-testid="kids-row">
                      <td className={tdClass}><input aria-label={`Grupa ${i + 1}`} className={`${cellInput} w-full min-w-[140px]`} value={r.label} onChange={setKidsField(c.categoryId, r.key, 'label')} /></td>
                      <td className={tdClass}>
                        <div className="flex items-center gap-1">
                          <input aria-label={`Rocznik od ${i + 1}`} inputMode="numeric" className={`${cellInput} w-[72px] text-center`} value={r.birthYearFrom ?? ''} onChange={setKidsField(c.categoryId, r.key, 'birthYearFrom', yearOf)} />
                          <span>–</span>
                          <input aria-label={`Rocznik do ${i + 1}`} inputMode="numeric" className={`${cellInput} w-[72px] text-center`} value={r.birthYearTo ?? ''} onChange={setKidsField(c.categoryId, r.key, 'birthYearTo', yearOf)} />
                        </div>
                      </td>
                      <td className={tdClass}><input aria-label={`Dystans grupy ${i + 1}`} placeholder="ustal później" className={`${cellInput} w-[140px]`} value={r.distanceLabel} onChange={setKidsField(c.categoryId, r.key, 'distanceLabel')} /></td>
                      <td className={tdClass}>
                        <select aria-label={`Płeć ${i + 1}`} className={`${cellInput} w-[130px]`} value={r.gender ?? ''} onChange={setKidsField(c.categoryId, r.key, 'gender', genderOf)}>
                          <option value="">razem</option>
                          <option value="K">dziewczęta</option>
                          <option value="M">chłopcy</option>
                        </select>
                      </td>
                      <td className={`${tdClass} text-right`}>
                        <button type="button" aria-label={`Usuń grupę ${i + 1}`} className={`${btnGhost} text-base px-3`}
                          onClick={() => setKidsRows(c.categoryId, rows.filter((x) => x.key !== r.key))}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}

      <FieldError message={localError ?? (Object.keys(serverErrors).length ? Object.values(serverErrors).join(' ') : null)} />
      {!adults.length && !kidsComps.length && <span className={monoLabel}>Brak konkurencji</span>}
    </fieldset>
  )
}
