import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { previewRegistrationEvent } from '../../../../lib/organizer.js'
import { initials, linkHost, moveId, partnerForm, partnerRequest } from '../../../../lib/partnersModel.js'
import { logoResize } from '../../../../lib/logoResize.js'
import { btnGhost, btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from '../entries/EntryDialog.jsx'
import { cardClass, cardTitle, dangerSmall, ghostSmall } from '../wizardUi.jsx'
import ConfirmDelete from './ConfirmDelete.jsx'

// „Partnerzy”: the event's partners, one list for the public event page, the live results, the
// discount codes and the admin app (event_partners). Not a section: every change goes through
// organizer-partners (and the logo through upload-partner-logo) and applies at once, in a draft and
// after publish alike, never staged. Owner and admins edit; the functions answer anybody else 404,
// so a club member sees the public partners the runner preview shows, read-only.
// A dialog keeps the entries panel's rules (EntryDialog): a 422 marks its fields, any other refusal
// reads next to the buttons. A row action's refusal reads under the card.

const partnersCall = (eventId, body) => callFunction('organizer-partners', { eventId, ...body })
const failure = (err) => (err.status == null ? 'Brak połączenia.' : err.message)

/** The 48 px square a row shows: the logo on a light tile, or the name's initials. */
function Thumb({ name, logoUrl, size = 'w-12 h-12' }) {
  if (logoUrl) {
    return (
      <span className={`${size} shrink-0 flex items-center justify-center bg-white border border-apex-border-mid p-1`}>
        <img src={logoUrl} alt="" className="max-w-full max-h-full object-contain" />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className={`${size} shrink-0 flex items-center justify-center border border-apex-border-mid bg-apex-surface-2 font-display font-extrabold text-lg text-apex-muted`}>
      {initials(name)}
    </span>
  )
}

/** One labelled field of the dialog, its 422 message under it and linked to it. */
function Field({ id, label, error, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={dialogLabel}>{label}</label>
      {children}
      <FieldMessage id={`${id}-err`} message={error} />
    </div>
  )
}

const invalidProps = (id, error) => (error ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-err` } : {})

/**
 * „+ Partner” and „Zmień”. The logo is chosen here and sent after the fields: a new partner has no
 * id before `create`. If the logo fails after the partner was saved, the dialog stays open on that
 * partner (a retry updates it, never creates a second one) with the reason under „Logo”.
 */
function PartnerDialog({ eventId, partner, onClose, onDone, onSaved }) {
  const ids = useId()
  const id = (k) => `${ids}-${k}`
  const fileInput = useRef(null)
  const [savedId, setSavedId] = useState(partner?.id ?? null)
  const [form, setForm] = useState(() => partnerForm(partner))
  // keep: the stored logo; { dataUrl }: a new one to upload; remove: drop the stored one.
  const [logo, setLogo] = useState('keep')
  const [preparing, setPreparing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const shownLogo = logo === 'remove' ? null : logo === 'keep' ? partner?.logoUrl ?? null : logo.dataUrl

  async function choose(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setPreparing(true)
    setFields((f) => ({ ...f, logo: undefined }))
    try {
      setLogo({ dataUrl: await logoResize(file) })
    } catch (err) {
      setFields((f) => ({ ...f, logo: err.message }))
    } finally {
      setPreparing(false)
    }
  }

  async function submit() {
    setBusy(true)
    setError(null)
    setFields({})
    const body = partnerRequest(form)
    let id_ = savedId
    try {
      if (id_) await partnersCall(eventId, { action: 'update', id: id_, ...body })
      else {
        const r = await partnersCall(eventId, { action: 'create', ...body })
        id_ = r.data.id
        setSavedId(id_)
        onSaved()
      }
    } catch (err) {
      const named = err.fields && Object.keys(err.fields).length ? err.fields : null
      setFields(named ?? {})
      setError(named ? null : failure(err))
      setBusy(false)
      return
    }
    if (logo !== 'keep') {
      try {
        await callFunction('upload-partner-logo', logo === 'remove'
          ? { eventId, partnerId: id_, remove: true }
          : { eventId, partnerId: id_, dataUrl: logo.dataUrl })
      } catch (err) {
        onSaved()
        setFields({ logo: failure(err) })
        setBusy(false)
        return
      }
    }
    onDone(partner ? `Zapisano — ${body.name}.` : `Dodano partnera ${body.name}.`)
  }

  const off = busy || preparing
  return (
    <EntryDialog testId="partner-form" title={partner ? 'Partner' : 'Nowy partner'} subtitle={partner?.name} busy={busy}
      onClose={onClose} error={error}
      actions={<button type="button" className={btnPrimary} disabled={off} onClick={submit}>{savedId ? 'Zapisz' : 'Dodaj partnera'}</button>}>
      <Field id={id('name')} label="Nazwa" error={fields.name}>
        <input id={id('name')} value={form.name} maxLength={80} autoComplete="off" disabled={busy} onChange={set('name')}
          {...invalidProps(id('name'), fields.name)} className={`${dialogInput} ${fields.name ? 'border-apex-red' : ''}`} />
      </Field>
      <Field id={id('websiteUrl')} label="Link do strony (opcjonalnie)" error={fields.websiteUrl}>
        <input id={id('websiteUrl')} type="url" inputMode="url" value={form.websiteUrl} maxLength={500} autoComplete="off"
          placeholder="https://" disabled={busy} onChange={set('websiteUrl')}
          {...invalidProps(id('websiteUrl'), fields.websiteUrl)} className={`${dialogInput} ${fields.websiteUrl ? 'border-apex-red' : ''}`} />
      </Field>
      <Field id={id('note')} label="Notatka (widoczna tylko dla organizatorów)" error={fields.note}>
        <textarea id={id('note')} value={form.note} maxLength={500} rows={3} disabled={busy} onChange={set('note')}
          {...invalidProps(id('note'), fields.note)} className={`${dialogInput} resize-y ${fields.note ? 'border-apex-red' : ''}`} />
      </Field>
      <div className="min-w-0" role="group" aria-labelledby={id('logo')}>
        <span id={id('logo')} className={dialogLabel}>Logo</span>
        <div className="flex flex-wrap items-center gap-3">
          {shownLogo
            ? <Thumb name={form.name} logoUrl={shownLogo} size="w-20 h-20" />
            : <Thumb name={form.name || '?'} logoUrl={null} size="w-20 h-20" />}
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1}
              aria-hidden="true" data-testid="logo-input" onChange={choose} />
            <button type="button" className={btnGhost} disabled={off} aria-describedby={`${id('logo')}-hint`}
              onClick={() => fileInput.current?.click()}>Wgraj logo</button>
            {shownLogo && (
              <button type="button" className={btnGhost} disabled={off} onClick={() => setLogo('remove')}>Usuń logo</button>
            )}
          </div>
        </div>
        <p id={`${id('logo')}-hint`} className="mt-1.5 font-mono text-xs uppercase tracking-wide text-apex-muted">
          {preparing ? 'Przygotowuję…' : 'PNG, JPG lub WebP'}
        </p>
        <FieldMessage id={`${id('logo')}-err`} message={fields.logo} />
      </div>
      <label className="flex items-start gap-2.5 min-w-0 cursor-pointer">
        <input type="checkbox" checked={form.isPublic} disabled={busy} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
          className="mt-1 w-4 h-4 shrink-0 accent-apex-yellow" />
        <span className="font-sans text-base font-medium text-apex-text-bright">Pokazuj na stronie wydarzenia</span>
      </label>
      <FieldMessage message={fields.isPublic} />
    </EntryDialog>
  )
}

function PartnerRow({ p, first, last, writer, busy, onMove, onEdit, onDelete }) {
  const host = linkHost(p.websiteUrl)
  return (
    <li data-testid="partner-row"
      className="grid grid-cols-[48px_minmax(0,1fr)] sm:grid-cols-[48px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-3 py-3 border-b border-apex-border last:border-b-0">
      <Thumb name={p.name} logoUrl={p.logoUrl} />
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-sans font-semibold text-base text-apex-text-bright [overflow-wrap:anywhere]">{p.name}</span>
          {p.isPublic === false && (
            <span data-testid="partner-hidden" className="border border-apex-border-bright px-1.5 font-mono text-[11px] uppercase tracking-wide text-apex-muted">
              UKRYTY
            </span>
          )}
        </div>
        {host && (
          <a href={p.websiteUrl} target="_blank" rel="noopener noreferrer"
            className="font-mono text-xs text-apex-yellow hover:text-apex-yellow-bright [overflow-wrap:anywhere]">{host}</a>
        )}
        {p.note && <span className="font-sans text-sm text-apex-muted [overflow-wrap:anywhere]">{p.note}</span>}
      </div>
      {writer && (
        <div className="col-span-2 sm:col-span-1 flex flex-wrap gap-1.5 sm:justify-end sm:self-start">
          <button type="button" aria-label={`Wyżej — ${p.name}`} className={ghostSmall} disabled={busy || first} onClick={() => onMove(-1)}>↑</button>
          <button type="button" aria-label={`Niżej — ${p.name}`} className={ghostSmall} disabled={busy || last} onClick={() => onMove(1)}>↓</button>
          <button type="button" aria-label={`Zmień — ${p.name}`} className={ghostSmall} disabled={busy} onClick={onEdit}>Zmień</button>
          <button type="button" aria-label={`Usuń — ${p.name}`} className={dangerSmall} disabled={busy} onClick={onDelete}>Usuń</button>
        </div>
      )}
    </li>
  )
}

const LOADING = { status: 'loading', partners: [] }

export default function Partnerzy({ event, readOnly }) {
  const eventId = event.settings.eventId
  const writer = event.role === 'owner' || event.role === 'admin'
  const [state, setState] = useState(LOADING)
  const [dialog, setDialog] = useState(null) // { partner, trigger }
  const [notice, setNotice] = useState(null) // { text, error }
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null) // { partner, trigger }

  const load = useCallback(async () => {
    try {
      const partners = writer
        ? (await partnersCall(eventId, { action: 'list' })).data.partners ?? []
        : (await previewRegistrationEvent(eventId, false)).raw?.partners ?? []
      setState({ status: 'ok', partners })
    } catch {
      setState((s) => (s.status === 'ok' ? s : { ...LOADING, status: 'error' }))
    }
  }, [eventId, writer])

  useEffect(() => { load() }, [load])

  async function act(body, text) {
    setBusy(true)
    setNotice(null)
    try {
      await partnersCall(eventId, body)
      if (text) setNotice({ text })
    } catch (err) {
      setNotice({ text: failure(err), error: true })
    } finally {
      await load()
      setBusy(false)
    }
  }

  const back = (trigger) => requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus() })
  function closeDialog() {
    const t = dialog?.trigger
    setDialog(null)
    back(t)
  }
  async function done(text) {
    closeDialog()
    setNotice({ text })
    await load()
  }
  function closeConfirm() {
    const t = confirm?.trigger
    setConfirm(null)
    back(t)
  }
  async function confirmed() {
    const p = confirm.partner
    await act({ action: 'delete', id: p.id }, `Usunięto partnera ${p.name}.`)
    setConfirm(null)
  }

  if (state.status === 'loading') return <div className="h-24 bg-apex-surface-2 animate-pulse" aria-busy="true" />
  if (state.status === 'error') return <p className="text-apex-red text-sm">Nie udało się wczytać partnerów.</p>

  const canEdit = writer && !readOnly
  const list = state.partners
  const order = list.map((p) => p.id)

  return (
    <div className="flex flex-col gap-5">
      <section className={cardClass} data-testid="partners">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <h2 className={cardTitle}>Partnerzy</h2>
          {canEdit && (
            <button type="button" className={btnGhost} disabled={busy}
              onClick={(e) => setDialog({ partner: null, trigger: e.currentTarget })}>+ Partner</button>
          )}
        </div>
        {notice && (
          <p role={notice.error ? 'alert' : 'status'} data-testid="partners-notice"
            className={`font-sans text-sm ${notice.error ? 'text-apex-red' : 'text-apex-yellow'}`}>{notice.text}</p>
        )}
        {list.length === 0
          ? <p className="text-apex-muted text-sm" data-testid="partners-empty">Brak partnerów.</p>
          : (
            <ul className="flex flex-col border border-apex-border">
              {list.map((p, i) => (
                <PartnerRow key={p.id} p={p} first={i === 0} last={i === list.length - 1} writer={canEdit} busy={busy}
                  onMove={(delta) => { const ids = moveId(order, p.id, delta); if (ids) act({ action: 'reorder', ids }) }}
                  onEdit={(e) => setDialog({ partner: p, trigger: e?.currentTarget ?? null })}
                  onDelete={(e) => setConfirm({ partner: p, trigger: e?.currentTarget ?? null })} />
              ))}
            </ul>
          )}
      </section>

      {dialog && (
        <PartnerDialog eventId={eventId} partner={dialog.partner} onClose={closeDialog} onDone={done} onSaved={load} />
      )}
      {confirm && (
        <ConfirmDelete question={`Usunąć partnera ${confirm.partner.name}?`} busy={busy} onYes={confirmed} onNo={closeConfirm} />
      )}
    </div>
  )
}
