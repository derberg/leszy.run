import { lazy, Suspense, useRef, useState } from 'react'
import { slugify } from '@registration/slug.js'
import { validateSection } from '@registration/sections.js'
import TownSearch from '../../../../components/registration/TownSearch.jsx'
import { uploadDocument, uploadPoster } from '../../../../lib/organizer.js'
import { resizePoster } from '../../../../lib/resizePoster.js'
import { publicFileUrl } from '../../../../lib/registrationFiles.js'
import { btnGhost, errorClass, fieldInput, fieldLabel } from '../../settingsUi.js'
import { FieldError, MonoHint, sectionErrors } from '../wizardUi.jsx'

const DraggableMap = lazy(() => import('../../../../components/DraggableMap.jsx'))

const REGULAMIN_MAX = 10 * 1024 * 1024
const POSTER_MAX = 15 * 1024 * 1024

function initialForm(s) {
  return {
    name: s.name ?? '',
    slug: s.slug ?? '',
    eventDate: s.eventDate ?? '',
    firstStartTime: s.firstStartTime ? s.firstStartTime.slice(0, 5) : '',
    opensOn: s.opensOn ?? '',
    closesOn: s.closesOn ?? '',
    townLabel: s.townLabel ?? '',
    townArea: s.townArea ?? '',
    placeDetails: s.placeDetails ?? '',
    lat: s.lat == null ? null : Number(s.lat),
    lng: s.lng == null ? null : Number(s.lng),
    isCharity: !!s.isCharity,
    charityGoal: s.charityGoal ?? '',
    donationsEnabled: !!s.donationsEnabled,
    regulaminKind: s.regulaminKind ?? 'pdf',
    regulaminUrl: s.regulaminUrl ?? '',
    regulaminUploadId: s.regulaminUploadId ?? null,
    posterUploadId: s.posterUploadId ?? null,
  }
}

const orNull = (v) => (v === '' ? null : v)

// The whole basics section as save-registration-section takes it. The slug
// goes only when it differs from the stored one (a taken slug must not hold
// back every other field), and the registration window only as a pair.
function basicsValue(f, { state, savedSlug }) {
  const value = {
    name: f.name,
    eventDate: orNull(f.eventDate),
    firstStartTime: orNull(f.firstStartTime),
    townLabel: orNull(f.townLabel),
    townArea: orNull(f.townArea),
    placeDetails: orNull(f.placeDetails),
    lat: f.lat,
    lng: f.lng,
    isCharity: f.isCharity,
    charityGoal: orNull(f.charityGoal),
    donationsEnabled: f.donationsEnabled,
    regulaminKind: f.regulaminKind,
    regulaminUrl: orNull(f.regulaminUrl),
    regulaminUploadId: f.regulaminUploadId,
    posterUploadId: f.posterUploadId,
  }
  if (state === 'draft' && f.slug !== savedSlug) value.slug = f.slug
  if (!!f.opensOn === !!f.closesOn) {
    value.opensOn = orNull(f.opensOn)
    value.closesOn = orNull(f.closesOn)
  }
  return value
}

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Nie udało się odczytać pliku.'))
    r.readAsDataURL(blob)
  })
}

function FilePick({ label, accept, onFile, disabled, testId }) {
  const input = useRef(null)
  return (
    <>
      <button type="button" className={btnGhost} disabled={disabled} onClick={() => input.current?.click()}>{label}</button>
      <input ref={input} type="file" accept={accept} className="hidden" data-testid={testId}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f) }} />
    </>
  )
}

export default function Podstawy({ event, queue, saveState, readOnly, reload }) {
  const settings = event.settings
  const [form, setForm] = useState(() => initialForm(settings))
  const formRef = useRef(form) // the latest form, for writes that finish after an await
  const [localErrors, setLocalErrors] = useState({})
  const [uploading, setUploading] = useState(null) // 'regulamin' | 'poster'
  const [uploadError, setUploadError] = useState({})
  const errors = { ...sectionErrors(saveState, 'basics'), ...localErrors }
  const isDraft = settings.state === 'draft'
  const uploads = new Map((event.uploads ?? []).map((u) => [u.id, u]))

  function apply(next) {
    formRef.current = next
    setForm(next)
    const value = basicsValue(next, { state: settings.state, savedSlug: settings.slug })
    const result = validateSection('basics', value, { state: settings.state })
    setLocalErrors(result.ok ? {} : result.errors)
    if (result.ok) queue('basics', value)
  }

  const set = (field) => (e) => {
    const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e
    const prev = formRef.current
    const next = { ...prev, [field]: v }
    // The address follows the name until someone edits it.
    if (field === 'name' && isDraft && prev.slug === slugify(prev.name)) next.slug = slugify(v)
    apply(next)
  }

  async function onRegulamin(file) {
    setUploadError({})
    if (file.size > REGULAMIN_MAX || !/\.pdf$/i.test(file.name)) {
      setUploadError({ regulamin: 'Regulamin musi być plikiem PDF do 10 MB.' })
      return
    }
    setUploading('regulamin')
    try {
      const { uploadId } = await uploadDocument(settings.eventId, 'regulamin', file)
      apply({ ...formRef.current, regulaminKind: 'pdf', regulaminUploadId: uploadId })
      reload()
    } catch (err) {
      setUploadError({ regulamin: err.message })
    } finally {
      setUploading(null)
    }
  }

  async function onPoster(file) {
    setUploadError({})
    if (file.size > POSTER_MAX) {
      setUploadError({ poster: 'Plakat może mieć najwyżej 15 MB.' })
      return
    }
    setUploading('poster')
    try {
      const jpeg = await resizePoster(file)
      const { uploadId } = await uploadPoster(settings.eventId, await readDataUrl(jpeg), file.name)
      apply({ ...formRef.current, posterUploadId: uploadId })
      reload()
    } catch (err) {
      setUploadError({ poster: err.message })
    } finally {
      setUploading(null)
    }
  }

  const regulamin = form.regulaminUploadId ? uploads.get(form.regulaminUploadId) : null
  const poster = form.posterUploadId ? uploads.get(form.posterUploadId) : null
  const segClass = (on) => `whitespace-nowrap font-mono text-[13px] px-3 py-1.5 ${on ? 'bg-apex-yellow text-apex-ink' : 'text-apex-text hover:text-apex-text-bright'}`

  return (
    <fieldset disabled={readOnly} className="space-y-8 min-w-0">
      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] items-end">
        <div className="col-span-full">
          <label htmlFor="ev-name" className={fieldLabel}>Nazwa</label>
          <input id="ev-name" className={fieldInput} value={form.name} onChange={set('name')} />
          <FieldError message={errors.name} />
        </div>
        <div className="col-span-full">
          <label htmlFor="ev-slug" className={fieldLabel}>Adres strony</label>
          <div className="flex items-center border border-apex-border-mid bg-apex-bg focus-within:border-apex-yellow-dim min-w-0">
            <span className="pl-3.5 font-mono text-sm text-apex-muted whitespace-nowrap">leszy.run/events/</span>
            <input id="ev-slug" className="flex-1 min-w-0 bg-transparent py-2.5 pr-3.5 pl-0.5 font-mono text-[15px] text-apex-text-bright outline-none disabled:opacity-60"
              value={form.slug} disabled={!isDraft} onChange={set('slug')} />
          </div>
          <MonoHint>Po publikacji nie da się zmienić</MonoHint>
          <FieldError message={errors.slug} />
        </div>
        <div>
          <label htmlFor="ev-date" className={fieldLabel}>Data</label>
          <input id="ev-date" type="date" className={fieldInput} value={form.eventDate} onChange={set('eventDate')} />
          <FieldError message={errors.eventDate} />
        </div>
        <div>
          <label htmlFor="ev-start" className={fieldLabel}>Start pierwszej konkurencji</label>
          <input id="ev-start" type="time" className={fieldInput} value={form.firstStartTime} onChange={set('firstStartTime')} />
          <FieldError message={errors.firstStartTime} />
        </div>
        <div>
          <label htmlFor="ev-opens" className={fieldLabel}>Zapisy otwarte od</label>
          <input id="ev-opens" type="date" className={fieldInput} value={form.opensOn} onChange={set('opensOn')} />
          <FieldError message={errors.opensOn} />
        </div>
        <div>
          <label htmlFor="ev-closes" className={fieldLabel}>Zapisy online do</label>
          <input id="ev-closes" type="date" className={fieldInput} value={form.closesOn} onChange={set('closesOn')} />
          <FieldError message={errors.closesOn} />
        </div>
      </div>

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] items-start">
        <div className="space-y-4 min-w-0">
          <TownSearch id="ev-town" townLabel={form.townLabel} townArea={form.townArea} disabled={readOnly}
            onPick={(c) => apply({ ...formRef.current, townLabel: c.label, townArea: c.area || '', lat: c.lat, lng: c.lng })} />
          <div>
            <label htmlFor="ev-place" className={fieldLabel}>Szczegóły miejsca</label>
            <textarea id="ev-place" rows={3} className={`${fieldInput} resize-y`} value={form.placeDetails} onChange={set('placeDetails')} />
            <FieldError message={errors.placeDetails} />
          </div>
        </div>
        <div className="min-w-0">
          <span className={fieldLabel}>Start / meta na mapie</span>
          <Suspense fallback={<div className="h-[200px] border border-apex-border bg-apex-surface" />}>
            <DraggableMap lat={form.lat} lng={form.lng} height={200}
              onChange={(lat, lng) => { if (!readOnly) apply({ ...formRef.current, lat, lng }) }} />
          </Suspense>
        </div>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2.5 font-sans text-base text-apex-text-bright min-h-9">
          <input type="checkbox" className="w-[18px] h-[18px] accent-apex-yellow" checked={form.isCharity} onChange={set('isCharity')} />
          Wydarzenie charytatywne
        </label>
        {form.isCharity && (
          <div className="pl-7 space-y-3 max-w-[640px]">
            <div>
              <label htmlFor="ev-goal" className={fieldLabel}>Cel</label>
              <input id="ev-goal" className={fieldInput} value={form.charityGoal} onChange={set('charityGoal')} />
              <FieldError message={errors.charityGoal} />
            </div>
            <label className="flex items-center gap-2.5 font-sans text-base text-apex-text-bright min-h-9">
              <input type="checkbox" className="w-[18px] h-[18px] accent-apex-yellow" checked={form.donationsEnabled} onChange={set('donationsEnabled')} />
              Pozwól dopłacić darowiznę przy zapisie
              <span tabIndex={0} title="Zawodnik może dodać do opłaty startowej dowolną kwotę. Cała dopłata trafia na cel."
                aria-label="Zawodnik może dodać do opłaty startowej dowolną kwotę. Cała dopłata trafia na cel."
                className="inline-flex items-center justify-center w-5 h-5 border border-apex-border-bright font-mono text-xs text-apex-muted cursor-help">?</span>
            </label>
          </div>
        )}
      </div>

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] items-start">
        <div className="min-w-0">
          <span className={fieldLabel}>Regulamin zawodów</span>
          <div role="group" aria-label="Regulamin zawodów" className="flex w-max border border-apex-border-mid mb-2">
            <button type="button" className={segClass(form.regulaminKind === 'pdf')} aria-pressed={form.regulaminKind === 'pdf'}
              onClick={() => apply({ ...formRef.current, regulaminKind: 'pdf' })}>PLIK PDF</button>
            <button type="button" className={segClass(form.regulaminKind === 'link')} aria-pressed={form.regulaminKind === 'link'}
              onClick={() => apply({ ...formRef.current, regulaminKind: 'link' })}>LINK</button>
          </div>
          {form.regulaminKind === 'pdf' ? (
            <>
              <div className="flex items-center justify-between gap-3 min-h-[52px] px-3 border border-apex-border-mid bg-apex-bg">
                {regulamin ? (
                  <span className="min-w-0 truncate">
                    <a href={publicFileUrl(regulamin.path)} target="_blank" rel="noreferrer" data-testid="regulamin-file"
                      className="font-sans text-base text-apex-text-bright underline">regulamin.pdf</a>
                    <span className="font-mono text-xs text-apex-muted"> · {kb(regulamin.meta?.bytes ?? 0)}</span>
                  </span>
                ) : (
                  <span className="font-mono text-xs text-apex-muted">{uploading === 'regulamin' ? 'Wysyłanie…' : 'Brak pliku'}</span>
                )}
                <FilePick label={regulamin ? 'Podmień' : 'Wybierz plik'} accept="application/pdf,.pdf" testId="regulamin-input"
                  disabled={readOnly || !!uploading} onFile={onRegulamin} />
              </div>
              <MonoHint>PDF · do 10 MB</MonoHint>
              {uploadError.regulamin && <p className={`${errorClass} mt-1.5`}>{uploadError.regulamin}</p>}
            </>
          ) : (
            <>
              <input aria-label="Link do regulaminu" className={fieldInput} placeholder="https://" value={form.regulaminUrl} onChange={set('regulaminUrl')} />
              <FieldError message={errors.regulaminUrl} />
            </>
          )}
        </div>
        <div className="min-w-0">
          <span className={fieldLabel}>Plakat</span>
          <div className="flex items-center gap-3 min-h-[104px] p-2.5 border border-dashed border-apex-border-bright bg-apex-bg">
            {poster ? (
              <img src={publicFileUrl(poster.path)} alt="" className="w-16 h-[84px] object-cover border border-apex-border-mid flex-none" />
            ) : (
              <div className="w-16 h-[84px] border border-apex-border-mid bg-apex-surface flex-none" />
            )}
            <div className="min-w-0 flex flex-col gap-1">
              {poster ? (
                <>
                  <span data-testid="poster-file" className="truncate font-sans text-base text-apex-text-bright">{poster.meta?.fileName ?? 'plakat.jpg'}</span>
                  <span className="font-mono text-xs text-apex-muted">{poster.meta?.width}×{poster.meta?.height} · BEZ GPS</span>
                </>
              ) : (
                <span className="font-mono text-xs text-apex-muted">{uploading === 'poster' ? 'Wysyłanie…' : 'Brak plakatu'}</span>
              )}
              <div>
                <FilePick label={poster ? 'Podmień' : 'Wybierz plik'} accept="image/jpeg,image/png,image/webp" testId="poster-input"
                  disabled={readOnly || !!uploading} onFile={onPoster} />
              </div>
            </div>
          </div>
          <MonoHint>JPG · PNG · WEBP · do 15 MB · min. 1200 px</MonoHint>
          {uploadError.poster && <p className={`${errorClass} mt-1.5`}>{uploadError.poster}</p>}
        </div>
      </div>
    </fieldset>
  )
}
