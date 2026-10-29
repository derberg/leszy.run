import { useEffect, useRef, useState } from 'react'
import { uploadDocument } from '../../../../lib/organizer.js'
import {
  assignIds, competitionRow, competitionsSection, eventCapacity, newCompetitionRow,
} from '../../../../lib/competitionRows.js'
import { btnGhost } from '../../settingsUi.js'
import {
  FieldError, Lock, Soon, cardClass, cellInput, monoLabel, sectionErrors, tdClass, thClass,
} from '../wizardUi.jsx'

// A3: the event's competitions and the entry fee. A draft competition can be
// removed; after publish none can (ruling P2-R8): one without entries can be
// hidden and shown again, and every competition, hidden ones included, goes
// with each save. With entries its kind, price and a limit under the number
// registered are locked.

const GPX_MAX = 5 * 1024 * 1024

const km = (n) => (n == null ? null : `${String(Number(Number(n).toFixed(1))).replace('.', ',')} KM`)
const gpxSummary = (meta) => [km(meta?.km), meta?.upM != null ? `+${Math.round(meta.upM)} M` : null].filter(Boolean).join(' · ')

function GpxCell({ row, meta, disabled, busy, onFile }) {
  const input = useRef(null)
  const pick = () => input.current?.click()
  return (
    <>
      {row.gpxUploadId ? (
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[13px] text-apex-yellow whitespace-nowrap" data-testid="gpx-ok">✓ TRASA GPX</span>
          <span className="font-mono text-[11px] text-apex-muted whitespace-nowrap">
            {gpxSummary(meta)}{gpxSummary(meta) ? ' · ' : ''}
            <button type="button" disabled={disabled} onClick={pick} className="underline text-apex-muted hover:text-apex-text-bright disabled:no-underline">ZMIEŃ</button>
          </span>
        </div>
      ) : (
        <button type="button" className={btnGhost} disabled={disabled} onClick={pick}>{busy ? 'Wysyłanie…' : '+ GPX'}</button>
      )}
      <input ref={input} type="file" accept=".gpx,application/gpx+xml" className="hidden" data-testid={`gpx-input-${row.key}`}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f) }} />
    </>
  )
}

export default function Konkurencje({ event, queue, saveState, readOnly, onSaved, reportInvalid }) {
  const settings = event.settings
  const state = settings.state
  const published = state !== 'draft'
  const [rows, setRows] = useState(() => (event.competitions ?? []).map(competitionRow))
  const [pricingMode, setPricingMode] = useState(settings.pricingMode ?? 'free')
  const [rowErrors, setRowErrors] = useState({})
  const [sectionError, setSectionError] = useState(null) // whole section not savable (e.g. a missing price)
  const [uploading, setUploading] = useState(null) // row key
  const [uploadError, setUploadError] = useState(null)
  const [gpxMeta, setGpxMeta] = useState({}) // uploads made here, before the event is read again
  const latest = useRef({ rows, pricingMode })
  const sentKeys = useRef([])
  const serverErrors = sectionErrors(saveState, 'competitions')
  const uploads = new Map((event.uploads ?? []).map((u) => [u.id, u.meta]))

  // The save hands back the ids of competitions it created, in item order.
  useEffect(() => onSaved('competitions', (data) => {
    const next = assignIds(latest.current.rows, sentKeys.current, data?.categoryIds)
    latest.current = { ...latest.current, rows: next }
    setRows(next)
  }), [onSaved])

  // Read when the save starts, so it carries ids the previous save returned.
  const sectionNow = () => {
    const s = competitionsSection(latest.current.rows, { pricingMode: latest.current.pricingMode, state })
    sentKeys.current = s.sentKeys
    return s.value
  }

  function apply(nextRows, mode = latest.current.pricingMode) {
    const s = competitionsSection(nextRows, { pricingMode: mode, state })
    latest.current = { rows: s.rows, pricingMode: mode }
    setRows(s.rows)
    setPricingMode(mode)
    setRowErrors(s.rowErrors)
    setSectionError(s.ok ? null : 'Uzupełnij konkurencje: nazwa, limit miejsc i cena przy opłacie stałej.')
    if (s.ok) queue('competitions', sectionNow)
  }

  const setRow = (key, field) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    apply(latest.current.rows.map((r) => (r.key === key ? { ...r, [field]: v } : r)))
  }
  const addRow = () => {
    const next = [...latest.current.rows, newCompetitionRow()]
    latest.current = { ...latest.current, rows: next }
    setRows(next)
  }
  const removeRow = (key) => apply(latest.current.rows.filter((r) => r.key !== key))
  const toggleHidden = (key) => apply(latest.current.rows.map((r) => (r.key === key ? { ...r, hidden: !r.hidden } : r)))

  async function onGpx(key, file) {
    setUploadError(null)
    if (file.size > GPX_MAX || !/\.gpx$/i.test(file.name)) {
      setUploadError('Trasa musi być plikiem GPX do 5 MB.')
      return
    }
    setUploading(key)
    try {
      const { uploadId, meta } = await uploadDocument(settings.eventId, 'gpx', file)
      setGpxMeta((m) => ({ ...m, [uploadId]: meta }))
      apply(latest.current.rows.map((r) => (r.key === key ? { ...r, gpxUploadId: uploadId } : r)))
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setUploading(null)
    }
  }

  // Input that does not validate yet keeps the organizer on this step (P2-R27).
  const firstRowError = Object.values(rowErrors).map((e) => Object.values(e).join(' ')).find(Boolean)
  useEffect(() => {
    const message = firstRowError ?? sectionError
    reportInvalid?.('competitions', message ? { items: message } : null)
  }, [firstRowError, sectionError, reportInvalid])
  useEffect(() => () => reportInvalid?.('competitions', null), [reportInvalid])

  const total = eventCapacity(rows)
  const radio = 'flex items-center gap-2.5 min-h-9 font-sans text-base text-apex-text-bright'
  const errorsOf = (key) => Object.values(rowErrors[key] ?? {})

  return (
    <fieldset disabled={readOnly} className="space-y-6 min-w-0">
      <div className="relative overflow-x-auto border border-apex-border">
        <table className="w-full border-collapse min-w-[1180px]" data-testid="competitions">
          <thead>
            <tr>
              <th className={thClass}>Konkurencja</th>
              <th className={thClass}>Rodzaj</th>
              <th className={thClass}>Dyscyplina</th>
              <th className={thClass}>Dystans</th>
              <th className={thClass}>Start</th>
              <th className={thClass}>Limit</th>
              <th className={thClass}>Wiek</th>
              <th className={thClass}>Dzieci</th>
              <th className={thClass}>Trasa</th>
              <th className={thClass}><span className="sr-only">Akcje</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const locked = published && r.taken > 0
              const n = i + 1
              return [
                <tr key={r.key} data-testid="competition-row" className={r.hidden ? 'opacity-60' : r.isKids ? 'bg-apex-surface' : ''}>
                  <td className={tdClass}>
                    <input aria-label={`Nazwa konkurencji ${n}`} className={`${cellInput} w-full min-w-[180px]`} value={r.name} onChange={setRow(r.key, 'name')} />
                    {r.hidden && <span className="inline-block mt-1 font-mono text-[11px] uppercase text-apex-muted border border-apex-border-bright px-1.5" data-testid="hidden-tag">Ukryta</span>}
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-1.5">
                      <select aria-label={`Rodzaj ${n}`} className={`${cellInput} w-[170px]`} value="individual" disabled={locked} onChange={() => {}}>
                        <option value="individual">Indywidualna</option>
                        <option value="team" disabled>Drużyna · wkrótce</option>
                      </select>
                      {locked && <Lock title="Są zapisy: rodzaju nie można zmienić" />}
                    </div>
                  </td>
                  <td className={tdClass}>
                    <select aria-label={`Dyscyplina ${n}`} className={`${cellInput} w-[150px]`} value={r.discipline ?? 'run'} onChange={setRow(r.key, 'discipline')}>
                      <option value="run">Bieg</option>
                      <option value="nw">Nordic walking</option>
                    </select>
                  </td>
                  <td className={tdClass}>
                    <input aria-label={`Dystans ${n}`} className={`${cellInput} w-[90px]`} value={r.distanceLabel} onChange={setRow(r.key, 'distanceLabel')} />
                  </td>
                  <td className={tdClass}>
                    <input aria-label={`Start ${n}`} type="time" className={`${cellInput} w-[110px]`} value={r.startTime} onChange={setRow(r.key, 'startTime')} />
                  </td>
                  <td className={tdClass}>
                    <input aria-label={`Limit ${n}`} inputMode="numeric" className={`${cellInput} w-[76px]`} value={r.capacity} onChange={setRow(r.key, 'capacity')} />
                    {locked && <span className="block mt-1 font-mono text-[11px] text-apex-muted whitespace-nowrap" data-testid="capacity-min">MIN. {r.taken}</span>}
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-1">
                      <input aria-label={`Wiek od ${n}`} inputMode="numeric" placeholder="od" className={`${cellInput} w-[56px] text-center`} value={r.minAge} onChange={setRow(r.key, 'minAge')} />
                      <span>–</span>
                      <input aria-label={`Wiek do ${n}`} inputMode="numeric" placeholder="do" className={`${cellInput} w-[56px] text-center`} value={r.maxAge} onChange={setRow(r.key, 'maxAge')} />
                    </div>
                  </td>
                  <td className={tdClass}>
                    <input type="checkbox" aria-label={`Dzieci ${n}`} className="w-[18px] h-[18px] mt-2.5 accent-apex-cyan" checked={r.isKids} onChange={setRow(r.key, 'isKids')} />
                  </td>
                  <td className={tdClass}>
                    <GpxCell row={r} meta={gpxMeta[r.gpxUploadId] ?? uploads.get(r.gpxUploadId)} disabled={readOnly || !!uploading}
                      busy={uploading === r.key} onFile={(f) => onGpx(r.key, f)} />
                  </td>
                  <td className={`${tdClass} text-right`}>
                    {!published && (
                      <button type="button" aria-label={`Usuń konkurencję ${n}`} className={`${btnGhost} text-base px-3`} onClick={() => removeRow(r.key)}>×</button>
                    )}
                    {published && r.taken === 0 && (
                      <button type="button" className={btnGhost} onClick={() => toggleHidden(r.key)}>
                        {r.hidden ? 'Pokaż konkurencję' : 'Ukryj konkurencję'}
                      </button>
                    )}
                  </td>
                </tr>,
                errorsOf(r.key).length > 0 && (
                  <tr key={`${r.key}-err`}>
                    <td colSpan={10} className="px-2.5 pb-2"><FieldError message={errorsOf(r.key).join(' ')} /></td>
                  </tr>
                ),
              ]
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="px-2.5 py-2.5 font-mono text-[13px] text-apex-muted text-right">LIMIT WYDARZENIA</td>
              <td colSpan={5} className="px-2.5 py-2.5 font-mono text-sm text-apex-yellow" data-testid="event-capacity">{total} OSÓB</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap gap-3 items-center">
        <button type="button" className={btnGhost} onClick={addRow}>+ Konkurencja</button>
        {uploadError && <span className="text-apex-red font-sans text-sm">{uploadError}</span>}
      </div>
      {Object.keys(serverErrors).length > 0 && <FieldError message={Object.values(serverErrors).join(' ')} />}
      {sectionError && !firstRowError && <FieldError message={sectionError} />}

      <section className={cardClass}>
        <span className={monoLabel}>Opłata startowa</span>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <label className={radio}>
            <input type="radio" name="pricing" className="w-[18px] h-[18px] accent-apex-yellow" disabled={published}
              checked={pricingMode === 'fixed'} onChange={() => apply(latest.current.rows, 'fixed')} />
            Stała
          </label>
          <label className={`${radio} opacity-60`}>
            <input type="radio" name="pricing" className="w-[18px] h-[18px]" disabled checked={false} onChange={() => {}} />
            Rośnie z datą zapisu <Soon />
          </label>
          <label className={radio}>
            <input type="radio" name="pricing" className="w-[18px] h-[18px] accent-apex-yellow" disabled={published}
              checked={pricingMode === 'free'} onChange={() => apply(latest.current.rows, 'free')} />
            Bezpłatne
          </label>
          {published && <Lock title="Rodzaju opłaty nie można zmienić po publikacji" />}
        </div>
        {pricingMode === 'fixed' && (
          <div className="relative overflow-x-auto border border-apex-border">
            <table className="w-full border-collapse min-w-[360px]" data-testid="prices">
              <thead><tr><th className={thClass}>Konkurencja</th><th className={thClass}>Cena</th></tr></thead>
              <tbody>
                {rows.filter((r) => !r.hidden).map((r, i) => (
                  <tr key={r.key}>
                    <td className={`${tdClass} text-apex-text-bright`}>{r.name || `Konkurencja ${i + 1}`}</td>
                    <td className={tdClass}>
                      <div className="flex items-center gap-1.5">
                        <input aria-label={`Cena ${r.name || i + 1}`} inputMode="decimal" className={`${cellInput} w-[100px]`}
                          value={r.price} disabled={published && r.taken > 0} onChange={setRow(r.key, 'price')} />
                        <span className="font-mono text-sm text-apex-muted">zł</span>
                        {published && r.taken > 0 && <Lock title="Są zapisy: opłaty nie można zmienić" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </fieldset>
  )
}
