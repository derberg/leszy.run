import { useEffect, useId, useRef, useState } from 'react'
import { uploadExtraImage } from '../../../../lib/organizer.js'
import { resizePoster } from '../../../../lib/resizePoster.js'
import { publicFileUrl } from '../../../../lib/registrationFiles.js'
import { MAX_EXTRAS, MAX_VARIANTS } from '@registration/sections.js'
import {
  addVariant, assignExtraIds, competitionOn, extraRow, extraSold, extrasSection, newExtraRow, toggleCompetition,
} from '../../../../lib/extraRows.js'
import { btnGhost } from '../../settingsUi.js'
import { FieldError, Lock, Seg, cardClass, cellInput, monoLabel, sectionErrors } from '../wizardUi.jsx'

// A5b: products sold with the entry, each with an image, a price, an order deadline, variants
// with a stock and the competitions that offer it. The list autosaves as one section (staged
// after publish). Ruling 10 after publish: an extra with a sold variant keeps its price and
// stays, and a sold variant stays with at least what sold.

const removeBtn = 'inline-flex items-center justify-center w-10 h-10 shrink-0 border border-apex-border-bright text-apex-muted hover:text-apex-text-bright font-sans text-xl leading-none rounded-none'

const IMAGE_MAX = 15 * 1024 * 1024

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Nie udało się odczytać pliku.'))
    r.readAsDataURL(blob)
  })
}

/** A labelled input whose error is linked to it. */
function Field({ label, error, className = '', children }) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div className={`flex flex-col gap-1.5 min-w-0 ${className}`}>
      <label htmlFor={id} className={monoLabel}>{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? errorId : undefined })}
      {error && <p id={errorId} className="text-apex-red font-sans text-sm">{error}</p>}
    </div>
  )
}

function ExtraCard({ row, n, competitions, imageUrl, errors, published, readOnly, uploading, onChange, onImage, onRemove }) {
  const pick = useRef(null)
  const sold = published && extraSold(row)
  const fields = errors?.fields ?? {}
  const variantErrors = errors?.variants ?? {}
  const allIds = competitions.map((c) => c.categoryId)
  const set = (field) => (e) => onChange({ ...row, [field]: e.target.value })
  const setVariant = (key, field) => (e) => onChange({ ...row, variants: row.variants.map((v) => (v.key === key ? { ...v, [field]: e.target.value } : v)) })
  const dropVariant = (key) => onChange({ ...row, variants: row.variants.filter((v) => v.key !== key) })
  const groupId = useId()

  return (
    <section data-testid="extra" aria-label={row.name || `Dodatek ${n}`} className={`${cardClass} sm:grid sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-5`}>
      <div className="flex flex-col gap-1.5">
        {imageUrl ? (
          <img src={imageUrl} alt={row.name || `Dodatek ${n}`} className="w-full h-[140px] object-cover border border-apex-border-mid" />
        ) : (
          <div className="h-[140px] border border-apex-border-mid bg-apex-surface-2 flex items-center justify-center px-2 text-center font-display font-extrabold text-lg uppercase text-apex-text-bright break-words">
            {row.name || `Dodatek ${n}`}
          </div>
        )}
        {!readOnly && (
          <button type="button" className={`${btnGhost} self-start`} disabled={uploading} onClick={() => pick.current?.click()}>
            {uploading ? 'Wysyłanie…' : imageUrl ? 'Podmień zdjęcie' : 'Dodaj zdjęcie'}
          </button>
        )}
        <input ref={pick} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" data-testid="extra-image-input"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImage(f) }} />
        {fields.imageUploadId && <FieldError message={fields.imageUploadId} />}
      </div>

      <div className="flex flex-col gap-3.5 min-w-0">
        <div className="grid grid-cols-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 items-end">
          <Field label="Nazwa" error={fields.name} className="col-span-2 sm:col-span-1">
            {(p) => <input {...p} className={`${cellInput} w-full`} value={row.name} onChange={set('name')} />}
          </Field>
          <Field label="Cena" error={fields.price}>
            {(p) => (
              <div className="flex items-center gap-1.5">
                <input {...p} inputMode="decimal" className={`${cellInput} w-full`} value={row.price} disabled={sold} onChange={set('price')} />
                <span className="font-mono text-sm text-apex-muted">zł</span>
                {sold && <Lock title="Są zamówienia: ceny nie można zmienić" />}
              </div>
            )}
          </Field>
          <Field label="Zamówienia do" error={fields.orderUntil}>
            {(p) => <input {...p} type="date" className={`${cellInput} w-full`} value={row.orderUntil} onChange={set('orderUntil')} />}
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={monoLabel}>Warianty · limit sztuk</span>
          <ul className="flex flex-col gap-2">
            {row.variants.map((v, i) => {
              const k = i + 1
              const e = variantErrors[v.key] ?? {}
              const errId = `${groupId}-v${v.key}`
              const locked = published && v.sold > 0
              return (
                <li key={v.key} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input aria-label={`Wariant ${k}`} placeholder="np. M" className={`${cellInput} w-[140px]`} value={v.label}
                      aria-invalid={e.label ? true : undefined} aria-describedby={e.label || e.stock ? errId : undefined} onChange={setVariant(v.key, 'label')} />
                    <span className="text-apex-muted">·</span>
                    <input aria-label={`Limit sztuk ${k}`} inputMode="numeric" placeholder="bez limitu" className={`${cellInput} w-[110px]`} value={v.stock}
                      aria-invalid={e.stock ? true : undefined} aria-describedby={e.label || e.stock ? errId : undefined} onChange={setVariant(v.key, 'stock')} />
                    {locked && (
                      <span className="flex items-center gap-1.5">
                        <span data-testid="variant-sold" className="font-mono text-[11px] text-apex-muted whitespace-nowrap">SPRZEDANO {v.sold}</span>
                        <Lock title="Są zamówienia: wariantu nie można usunąć" />
                      </span>
                    )}
                    {!locked && row.variants.length > 1 && !readOnly && (
                      <button type="button" aria-label={`Usuń wariant ${k}`} className={removeBtn} onClick={() => dropVariant(v.key)}>×</button>
                    )}
                  </div>
                  {(e.label || e.stock) && <p id={errId} className="text-apex-red font-sans text-sm">{[e.label, e.stock].filter(Boolean).join(' ')}</p>}
                </li>
              )
            })}
          </ul>
          {fields.variants && <FieldError message={fields.variants} />}
          {!readOnly && (
            <button type="button" className={`${btnGhost} self-start`} disabled={row.variants.length >= MAX_VARIANTS}
              onClick={() => onChange(addVariant(row))}>+ wariant</button>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span id={`${groupId}-c`} className={monoLabel}>Dostępne w konkurencjach</span>
          <div role="group" aria-labelledby={`${groupId}-c`} className="flex flex-wrap gap-1.5">
            {competitions.map((c) => (
              <Seg key={c.categoryId} on={competitionOn(row.categoryIds, c.categoryId)}
                onClick={() => onChange({ ...row, categoryIds: toggleCompetition(row.categoryIds, allIds, c.categoryId) })}>
                {c.name}
              </Seg>
            ))}
          </div>
          {fields.categoryIds && <FieldError message={fields.categoryIds} />}
        </div>

        {!sold && !readOnly && (
          <button type="button" className={`${btnGhost} self-start`} onClick={onRemove}>Usuń dodatek</button>
        )}
      </div>
    </section>
  )
}

export default function Dodatki({ event, queue, saveState, readOnly, reload, onSaved, reportInvalid }) {
  const settings = event.settings
  const state = settings.state
  const published = state !== 'draft'
  const [rows, setRows] = useState(() => (event.extras ?? []).map(extraRow))
  const [cardErrors, setCardErrors] = useState({})
  const [uploading, setUploading] = useState(null) // card key
  const [uploadError, setUploadError] = useState(null)
  const latest = useRef(rows)
  const sent = useRef({ keys: [], variantKeys: [] })
  const serverErrors = sectionErrors(saveState, 'extras')
  const uploads = new Map((event.uploads ?? []).map((u) => [u.id, u.path]))
  // Only saved competitions can be linked.
  const competitions = (event.competitions ?? []).filter((c) => c.categoryId)
  const imageUrl = (id) => (id && uploads.get(id) ? publicFileUrl(uploads.get(id)) : null)

  useEffect(() => onSaved('extras', (data) => {
    const next = assignExtraIds(latest.current, sent.current.keys, sent.current.variantKeys, data?.extraIds, data?.variantIds)
    latest.current = next
    setRows(next)
  }), [onSaved])

  // Read when the save starts, so it carries ids the previous save returned.
  const sectionNow = () => {
    const s = extrasSection(latest.current, { state, eventDate: settings.eventDate ?? null })
    sent.current = { keys: s.sentKeys, variantKeys: s.sentVariantKeys }
    return s.value
  }

  function apply(next) {
    const s = extrasSection(next, { state, eventDate: settings.eventDate ?? null })
    latest.current = s.rows
    setRows(s.rows)
    setCardErrors(s.cardErrors)
    if (s.ok) queue('extras', sectionNow)
  }

  const change = (row) => apply(latest.current.map((r) => (r.key === row.key ? row : r)))
  const add = () => {
    const next = [...latest.current, newExtraRow()]
    latest.current = next
    setRows(next)
  }
  const remove = (key) => apply(latest.current.filter((r) => r.key !== key))

  async function onImage(key, file) {
    setUploadError(null)
    if (file.size > IMAGE_MAX) {
      setUploadError('Zdjęcie dodatku może mieć najwyżej 15 MB.')
      return
    }
    setUploading(key)
    try {
      const jpeg = await resizePoster(file)
      const { uploadId } = await uploadExtraImage(settings.eventId, await readDataUrl(jpeg), file.name)
      apply(latest.current.map((r) => (r.key === key ? { ...r, imageUploadId: uploadId } : r)))
      // The image is shown from the event's uploads, as the poster is.
      await reload?.()
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setUploading(null)
    }
  }

  // Input that does not validate yet keeps the organizer on this step (P2-R27).
  const firstError = Object.values(cardErrors)
    .map((e) => [...Object.values(e.fields), ...Object.values(e.variants).flatMap((v) => Object.values(v))].join(' '))
    .find(Boolean)
  useEffect(() => { reportInvalid?.('extras', firstError ? { items: firstError } : null) }, [firstError, reportInvalid])
  useEffect(() => () => reportInvalid?.('extras', null), [reportInvalid])

  return (
    <fieldset disabled={readOnly} className="space-y-4 min-w-0" data-testid="dodatki-step">
      {rows.map((r, i) => (
        <ExtraCard key={r.key} row={r} n={i + 1} competitions={competitions} imageUrl={imageUrl(r.imageUploadId)}
          errors={cardErrors[r.key]} published={published} readOnly={readOnly} uploading={uploading === r.key}
          onChange={change} onImage={(f) => onImage(r.key, f)} onRemove={() => remove(r.key)} />
      ))}
      {uploadError && <p role="alert" className="text-apex-red font-sans text-sm">{uploadError}</p>}
      {Object.keys(serverErrors).length > 0 && <FieldError message={Object.values(serverErrors).join(' ')} />}
      {!readOnly && <button type="button" className={btnGhost} disabled={rows.length >= MAX_EXTRAS} onClick={add}>+ Dodatek</button>}
    </fieldset>
  )
}
