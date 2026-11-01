import { useEffect, useId, useRef, useState } from 'react'
import { uploadDocument } from '../../../../lib/organizer.js'
import {
  addTier, assignIds, assignTierIds, capacityLabel, capacityUnit, competitionRow, competitionsSection, dayLabel,
  newCompetitionRow, switchPricing, tierColumns, tierLabel, tierLocks,
} from '../../../../lib/competitionRows.js'
import { btnGhost } from '../../settingsUi.js'
import {
  FieldError, Lock, cardClass, cellInput, monoLabel, sectionErrors, tdClass, thClass,
} from '../wizardUi.jsx'

// A3: the event's competitions and the entry fee. A draft competition can be
// removed; after publish none can (ruling P2-R8): one not in use can be
// hidden and shown again, and every competition, hidden ones included, goes
// with each save. In use (`inUse` from get-registration-event: confirmed entries
// or a live order awaiting payment, P3-R15) its kind, team size, price and hiding
// are locked, as the server's registration_check_locks refuses them. The limit
// may not go under the confirmed entries (`taken`, „MIN.”): an unpaid order holds
// no place. A team competition's limit and fee are per team.
// „Rośnie z datą zapisu” (D7-12): shared date columns, the last one open until
// registration closes, a price per competition per column. After publish the
// columns in force or past keep their dates once anyone registered, and a
// competition in use keeps its amounts in them (ruling 9); later columns stay
// editable.

const GPX_MAX = 5 * 1024 * 1024

const km = (n) => (n == null ? null : `${String(Number(Number(n).toFixed(1))).replace('.', ',')} KM`)
const gpxSummary = (meta) => [km(meta?.km), meta?.upM != null ? `+${Math.round(meta.upM)} M` : null].filter(Boolean).join(' · ')

const removeBtn = 'inline-flex items-center justify-center w-10 h-10 shrink-0 border border-apex-border-bright text-apex-muted hover:text-apex-text-bright font-sans text-xl leading-none rounded-none'

const PRICE_HINT = {
  fixed: 'Uzupełnij konkurencje: nazwa, limit miejsc i cena przy opłacie stałej.',
  tiered: 'Uzupełnij konkurencje: nazwa, limit miejsc i cena w każdym progu.',
  free: 'Uzupełnij konkurencje: nazwa i limit miejsc.',
}

function TierGrid({ rows, tiers, locks, closesOn, readOnly, errorId, error, onDate, onPrice, onAdd, onRemove }) {
  const dated = tiers.length - 1
  return (
    <>
      <div className="relative overflow-x-auto border border-apex-border">
        <table className="w-full border-collapse" style={{ minWidth: `${200 + tiers.length * 170}px` }} data-testid="tiers">
          <thead>
            <tr>
              <th className={`${thClass} align-bottom`}>Konkurencja</th>
              {tiers.map((t, k) => {
                const n = k + 1
                const last = k === dated
                const dateLocked = locks.date(t)
                return (
                  <th key={t.key} className={`${thClass} align-bottom`}>
                    <div className="flex flex-col gap-1">
                      <span>{last ? 'DO KOŃCA ZAPISÓW' : tierLabel(t.endsOn)}</span>
                      {last ? (
                        <span className="min-h-10 flex items-center font-mono text-[13px] text-apex-text-bright">{dayLabel(closesOn)}</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <input type="date" aria-label={`Próg ${n}: do`} className={`${cellInput} w-[150px]`} value={t.endsOn ?? ''}
                            disabled={dateLocked} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                            onChange={(e) => onDate(t.key, e.target.value)} />
                          {dateLocked && <Lock title="Są zgłoszenia: progu, który trwa lub minął, nie można zmienić" />}
                          {!dateLocked && dated > 0 && !readOnly && (
                            <button type="button" aria-label={`Usuń próg ${n}`} className={removeBtn} onClick={() => onRemove(t.key)}>×</button>
                          )}
                        </div>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className={r.hidden ? 'opacity-60' : ''}>
                <td className={`${tdClass} text-apex-text-bright`}>
                  <span className="block">{r.name || `Konkurencja ${i + 1}`}</span>
                  {r.kind === 'team' && <span className="block font-mono text-[11px] text-apex-muted whitespace-nowrap">ZA DRUŻYNĘ</span>}
                </td>
                {tiers.map((t, k) => {
                  const locked = locks.amount(t, r)
                  return (
                    <td key={t.key} className={tdClass}>
                      <div className="flex items-center gap-1.5">
                        <input aria-label={`Cena ${r.name || i + 1} · próg ${k + 1}`} inputMode="decimal" className={`${cellInput} w-[90px]`}
                          value={r.prices?.[t.key] ?? ''} disabled={locked} onChange={(e) => onPrice(r.key, t.key, e.target.value)} />
                        <span className="font-mono text-sm text-apex-muted">zł</span>
                        {locked && <Lock title="Są zgłoszenia: opłaty w progu, który trwa lub minął, nie można zmienić" />}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p id={errorId} role="alert" data-testid="tiers-error" className="text-apex-red font-sans text-sm">{error}</p>}
      {!readOnly && (
        <button type="button" className={`${btnGhost} self-start`} disabled={!locks.canAdd} onClick={onAdd}>+ Próg</button>
      )}
    </>
  )
}

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
  const [tiers, setTiers] = useState(() => tierColumns(event.tiers, settings.pricingMode))
  const [tierError, setTierError] = useState(null)
  const tierErrorId = useId()
  const [rowErrors, setRowErrors] = useState({})
  const [sectionError, setSectionError] = useState(null) // whole section not savable (e.g. a missing price)
  const [uploading, setUploading] = useState(null) // row key
  const [uploadError, setUploadError] = useState(null)
  const [gpxMeta, setGpxMeta] = useState({}) // uploads made here, before the event is read again
  const latest = useRef({ rows, pricingMode, tiers })
  const sentKeys = useRef([])
  const sentTierKeys = useRef([])
  const windowCtx = { opensAt: settings.opensAt ?? null, closesAt: settings.closesAt ?? null }
  const serverErrors = sectionErrors(saveState, 'competitions')
  const uploads = new Map((event.uploads ?? []).map((u) => [u.id, u.meta]))

  // The save hands back the ids of competitions it created, in item order.
  useEffect(() => onSaved('competitions', (data) => {
    const next = assignIds(latest.current.rows, sentKeys.current, data?.categoryIds)
    const nextTiers = assignTierIds(latest.current.tiers, sentTierKeys.current, data?.tierIds)
    latest.current = { ...latest.current, rows: next, tiers: nextTiers }
    setRows(next)
    setTiers(nextTiers)
  }), [onSaved])

  // Read when the save starts, so it carries ids the previous save returned.
  const sectionNow = () => {
    const { rows: r, pricingMode: mode, tiers: t } = latest.current
    const s = competitionsSection(r, { pricingMode: mode, state, tiers: t, ...windowCtx })
    sentKeys.current = s.sentKeys
    sentTierKeys.current = s.sentTierKeys
    return s.value
  }

  function apply(nextRows, mode = latest.current.pricingMode, nextTiers = latest.current.tiers) {
    const s = competitionsSection(nextRows, { pricingMode: mode, state, tiers: nextTiers, ...windowCtx })
    latest.current = { rows: s.rows, pricingMode: mode, tiers: nextTiers }
    setRows(s.rows)
    setPricingMode(mode)
    setTiers(nextTiers)
    setRowErrors(s.rowErrors)
    setTierError(s.tierError)
    setSectionError(s.ok || s.tierError ? null : PRICE_HINT[mode] ?? PRICE_HINT.free)
    if (s.ok) queue('competitions', sectionNow)
  }

  const switchMode = (mode) => apply(switchPricing(latest.current.rows, latest.current.tiers, mode), mode)
  const setTierDate = (key, endsOn) => apply(latest.current.rows, undefined, latest.current.tiers.map((t) => (t.key === key ? { ...t, endsOn } : t)))
  const addTierColumn = () => apply(latest.current.rows, undefined, addTier(latest.current.tiers))
  const removeTier = (key) => apply(
    latest.current.rows.map((r) => { const { [key]: _gone, ...prices } = r.prices ?? {}; return { ...r, prices } }),
    undefined, latest.current.tiers.filter((t) => t.key !== key))
  const setPrice = (rowKey, tierKey, value) => apply(latest.current.rows.map((r) => (r.key === rowKey ? { ...r, prices: { ...r.prices, [tierKey]: value } } : r)))
  const locks = tierLocks(tiers, rows, { published })

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
    const message = firstRowError ?? tierError ?? sectionError
    reportInvalid?.('competitions', message ? { items: message } : null)
  }, [firstRowError, tierError, sectionError, reportInvalid])
  useEffect(() => () => reportInvalid?.('competitions', null), [reportInvalid])

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
              const locked = published && r.inUse
              const n = i + 1
              return [
                <tr key={r.key} data-testid="competition-row" className={r.hidden ? 'opacity-60' : r.isKids ? 'bg-apex-surface' : ''}>
                  <td className={tdClass}>
                    <input aria-label={`Nazwa konkurencji ${n}`} className={`${cellInput} w-full min-w-[180px]`} value={r.name} onChange={setRow(r.key, 'name')} />
                    {r.hidden && <span className="inline-block mt-1 font-mono text-[11px] uppercase text-apex-muted border border-apex-border-bright px-1.5" data-testid="hidden-tag">Ukryta</span>}
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-1.5">
                      <select aria-label={`Rodzaj ${n}`} className={`${cellInput} w-[170px]`} value={r.kind} disabled={locked} onChange={setRow(r.key, 'kind')}>
                        <option value="individual">Indywidualna</option>
                        <option value="team">Drużyna</option>
                      </select>
                      {locked && <Lock title="Są zgłoszenia: rodzaju nie można zmienić" />}
                    </div>
                    {r.kind === 'team' && (
                      <div className="flex items-center gap-1 mt-1.5" data-testid="team-size">
                        <input aria-label={`Skład od ${n}`} inputMode="numeric" placeholder="min" className={`${cellInput} w-[56px] text-center`} value={r.teamMin} disabled={locked} onChange={setRow(r.key, 'teamMin')} />
                        <span>–</span>
                        <input aria-label={`Skład do ${n}`} inputMode="numeric" placeholder="max" className={`${cellInput} w-[56px] text-center`} value={r.teamMax} disabled={locked} onChange={setRow(r.key, 'teamMax')} />
                        <span className="font-mono text-[11px] text-apex-muted whitespace-nowrap">OSÓB</span>
                        {locked && <Lock title="Są zgłoszenia: składu nie można zmienić" />}
                      </div>
                    )}
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
                    <div className="flex items-center gap-1.5">
                      <input aria-label={`Limit ${n}`} inputMode="numeric" className={`${cellInput} w-[76px]`} value={r.capacity} onChange={setRow(r.key, 'capacity')} />
                      {r.kind === 'team' && <span className="font-mono text-[11px] text-apex-muted whitespace-nowrap" data-testid="capacity-unit">{capacityUnit(r.capacity)}</span>}
                    </div>
                    {published && r.taken > 0 && <span className="block mt-1 font-mono text-[11px] text-apex-muted whitespace-nowrap" data-testid="capacity-min">MIN. {r.taken}</span>}
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
                    {published && !r.inUse && (
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
              <td colSpan={10} className="px-2.5 py-2.5">
                <div className="sticky left-2.5 w-fit flex items-baseline gap-3 whitespace-nowrap">
                  <span className="font-mono text-[13px] text-apex-muted">LIMIT WYDARZENIA</span>
                  <span className="font-mono text-sm text-apex-yellow" data-testid="event-capacity">{capacityLabel(rows)}</span>
                </div>
              </td>
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
              checked={pricingMode === 'fixed'} onChange={() => switchMode('fixed')} />
            Stała
          </label>
          <label className={radio}>
            <input type="radio" name="pricing" className="w-[18px] h-[18px] accent-apex-yellow" disabled={published}
              checked={pricingMode === 'tiered'} onChange={() => switchMode('tiered')} />
            Rośnie z datą zapisu
          </label>
          <label className={radio}>
            <input type="radio" name="pricing" className="w-[18px] h-[18px] accent-apex-yellow" disabled={published}
              checked={pricingMode === 'free'} onChange={() => switchMode('free')} />
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
                          value={r.price} disabled={published && r.inUse} onChange={setRow(r.key, 'price')} />
                        <span className="font-mono text-sm text-apex-muted">zł</span>
                        {published && r.inUse && <Lock title="Są zgłoszenia: opłaty nie można zmienić" />}
                      </div>
                      {r.kind === 'team' && <span className="block mt-1 font-mono text-[11px] text-apex-muted whitespace-nowrap">ZA DRUŻYNĘ</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pricingMode === 'tiered' && (
          <TierGrid rows={rows} tiers={tiers} locks={locks} closesOn={settings.closesOn} readOnly={readOnly}
            errorId={tierErrorId} error={tierError} onDate={setTierDate} onPrice={setPrice} onAdd={addTierColumn} onRemove={removeTier} />
        )}
      </section>
    </fieldset>
  )
}
