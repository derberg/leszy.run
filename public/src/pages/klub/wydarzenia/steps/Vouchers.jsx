import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { warsawToday } from '@registration/dates.js'
import { callFunction } from '../../../../lib/auth.js'
import { downloadCsv } from '../../../../lib/csvDownload.js'
import { competitionOn, toggleCompetition } from '../../../../lib/extraRows.js'
import { voucherRequest, voucherView } from '../../../../lib/vouchersModel.js'
import { btnDanger, btnGhost, btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from '../entries/EntryDialog.jsx'
import { Seg, cardClass, cardTitle, monoLabel, tdClass, thClass } from '../wizardUi.jsx'

// Płatności „Kody rabatowe” and „Partnerzy” (A6, Plan 7). Both go through organizer-vouchers and,
// unlike the sections, apply at once, in a draft and after publish alike (ruling 11). Owner and
// admins only: the function answers a member 404, and Płatności renders this for writers only.
// A dialog keeps the dialogs of the entries panel (EntryDialog): a 422 marks its fields, any other
// refusal reads next to the buttons. A row action's refusal reads under its card.

const smallBtn = 'min-h-9 px-2.5 border font-sans font-bold text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed'
const ghostSmall = `${smallBtn} border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim`
const dangerSmall = `${smallBtn} border-apex-red text-apex-red hover:bg-apex-red hover:text-white`

const vouchersCall = (eventId, body) => callFunction('organizer-vouchers', { eventId, ...body })
const failure = (err) => (err.status == null ? 'Brak połączenia.' : err.message)

/** One labelled input of a dialog, its 422 message under it and linked to it. */
function Field({ id, label, error, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={dialogLabel}>{label}</label>
      {children}
      <FieldMessage id={`${id}-err`} message={error} />
    </div>
  )
}

const invalidProps = (id, error) => (error
  ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-err` }
  : {})

/** „+ Kod” and „Wygeneruj kody”: one form, the generate variant without a code and a limit. */
function CodeDialog({ eventId, generate, partners, competitions, onClose, onDone }) {
  const ids = useId()
  const [form, setForm] = useState({ code: '', n: '20', prefix: '', percent: '', maxUses: '1', validUntil: '', partnerId: '', categoryIds: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const id = (k) => `${ids}-${k}`
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const allIds = competitions.map((c) => c.categoryId)

  async function submit() {
    setBusy(true)
    setError(null)
    setFields({})
    try {
      const r = await vouchersCall(eventId, { action: generate ? 'generate' : 'create', ...voucherRequest(form, { generate }) })
      onDone(generate ? `Wygenerowano kody: ${r.data.count}.` : `Dodano kod ${r.data.code}.`)
    } catch (err) {
      // The panel dialogs' contract: a 422 names its fields under them; the message by the button
      // only when no field is named (9b M-3).
      const named = err.fields && Object.keys(err.fields).length ? err.fields : null
      setFields(named ?? {})
      setError(named ? null : failure(err))
      setBusy(false)
    }
  }

  const input = (k, label, props = {}) => (
    <Field id={id(k)} label={label} error={fields[k]}>
      <input id={id(k)} value={form[k]} onChange={set(k)} disabled={busy} autoComplete="off" {...invalidProps(id(k), fields[k])}
        className={`${dialogInput} ${fields[k] ? 'border-apex-red' : ''}`} {...props} />
    </Field>
  )

  return (
    <EntryDialog testId={generate ? 'generate-dialog' : 'code-dialog'} title={generate ? 'Wygeneruj kody' : 'Nowy kod'} busy={busy}
      onClose={onClose} error={error} wide
      actions={(
        <button type="button" className={btnPrimary} disabled={busy} onClick={submit}>{generate ? 'Wygeneruj' : 'Dodaj kod'}</button>
      )}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {generate
          ? <>{input('n', 'Liczba kodów', { inputMode: 'numeric' })}{input('prefix', 'Przedrostek · opcjonalnie', { maxLength: 23 })}</>
          : input('code', 'Kod · opcjonalnie', { maxLength: 32, className: `${dialogInput} font-mono uppercase ${fields.code ? 'border-apex-red' : ''}` })}
        {input('percent', 'Rabat (%)', { inputMode: 'numeric' })}
        {!generate && input('maxUses', 'Limit użyć', { inputMode: 'numeric' })}
        {input('validUntil', 'Ważny do · opcjonalnie', { type: 'date' })}
        <Field id={id('partnerId')} label="Partner" error={fields.partnerId}>
          <select id={id('partnerId')} value={form.partnerId} onChange={set('partnerId')} disabled={busy}
            {...invalidProps(id('partnerId'), fields.partnerId)} className={`${dialogInput} ${fields.partnerId ? 'border-apex-red' : ''}`}>
            <option value="">—</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      {competitions.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span id={id('c')} className={monoLabel}>Konkurencje</span>
          <div role="group" aria-labelledby={id('c')} className="flex flex-wrap gap-1.5">
            {competitions.map((c) => (
              <Seg key={c.categoryId} check on={competitionOn(form.categoryIds, c.categoryId)} disabled={busy}
                onClick={() => setForm({ ...form, categoryIds: toggleCompetition(form.categoryIds, allIds, c.categoryId) })}>
                {c.name}
              </Seg>
            ))}
          </div>
          <FieldMessage message={fields.categoryIds} />
        </div>
      )}
    </EntryDialog>
  )
}

/** „+ Partner” and a partner's edit: the name and a note only the club sees. */
function PartnerForm({ eventId, partner, onClose, onDone }) {
  const ids = useId()
  const [form, setForm] = useState({ name: partner?.name ?? '', note: partner?.note ?? '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const id = (k) => `${ids}-${k}`

  async function submit() {
    setBusy(true)
    setError(null)
    setFields({})
    try {
      const note = form.note.trim() || null
      await vouchersCall(eventId, partner
        ? { action: 'partner_update', id: partner.id, name: form.name, note }
        : { action: 'partner_create', name: form.name, note })
      onDone(partner ? `Zapisano — ${form.name.trim()}.` : `Dodano partnera ${form.name.trim()}.`)
    } catch (err) {
      // The panel dialogs' contract: a 422 names its fields under them; the message by the button
      // only when no field is named (9b M-3).
      const named = err.fields && Object.keys(err.fields).length ? err.fields : null
      setFields(named ?? {})
      setError(named ? null : failure(err))
      setBusy(false)
    }
  }

  return (
    <EntryDialog testId="partner-form" title={partner ? 'Partner' : 'Nowy partner'} subtitle={partner?.name} busy={busy}
      onClose={onClose} error={error}
      actions={<button type="button" className={btnPrimary} disabled={busy} onClick={submit}>{partner ? 'Zapisz' : 'Dodaj partnera'}</button>}>
      <Field id={id('name')} label="Nazwa" error={fields.name}>
        <input id={id('name')} value={form.name} maxLength={80} autoComplete="off" disabled={busy}
          onChange={(e) => setForm({ ...form, name: e.target.value })} {...invalidProps(id('name'), fields.name)}
          className={`${dialogInput} ${fields.name ? 'border-apex-red' : ''}`} />
      </Field>
      <Field id={id('note')} label="Notatka · opcjonalnie" error={fields.note}>
        <textarea id={id('note')} value={form.note} maxLength={500} rows={3} disabled={busy}
          onChange={(e) => setForm({ ...form, note: e.target.value })} {...invalidProps(id('note'), fields.note)}
          className={`${dialogInput} resize-y`} />
      </Field>
    </EntryDialog>
  )
}

/** Asks before a delete, as the panel asks before „Podpisany w biurze”: a deleted code or partner is gone (9b M-2). */
function ConfirmDelete({ question, busy, onYes, onNo }) {
  const titleId = useId()
  const no = useRef(null)
  useEffect(() => { no.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onNo() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onNo])
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} data-testid="confirm-delete"
        className="w-full max-w-[420px] border border-apex-border-bright bg-apex-surface p-5 flex flex-col gap-4">
        <p id={titleId} className="font-sans font-semibold text-base text-apex-text-bright break-words">{question}</p>
        <div className="flex gap-2 justify-end">
          <button type="button" ref={no} className={btnGhost} disabled={busy} onClick={onNo}>Nie</button>
          <button type="button" className={btnDanger} disabled={busy} onClick={onYes}>Usuń</button>
        </div>
      </div>
    </div>
  )
}

const EMPTY = { status: 'loading', vouchers: [], partners: [] }

/**
 * @param {{ eventId: string, competitions: { categoryId: string, name: string, hiddenAt?: string|null }[] }} props
 */
export default function Vouchers({ eventId, competitions }) {
  const [state, setState] = useState(EMPTY)
  const [dialog, setDialog] = useState(null) // { kind: 'code' | 'generate' | 'partner', partner?, trigger }
  const [notice, setNotice] = useState(null) // { text, error, card: 'codes' | 'partners' }
  const [busyRow, setBusyRow] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [confirm, setConfirm] = useState(null) // { question, card, rowId, body, text, trigger }
  const shown = competitions.filter((c) => c.categoryId && !c.hiddenAt)

  const load = useCallback(async () => {
    try {
      const r = await vouchersCall(eventId, { action: 'list' })
      setState({ status: 'ok', vouchers: r.data.vouchers ?? [], partners: r.data.partners ?? [] })
    } catch {
      setState((s) => (s.status === 'ok' ? s : { ...EMPTY, status: 'error' }))
    }
  }, [eventId])

  useEffect(() => { load() }, [load])

  async function act(card, rowId, body, text) {
    setBusyRow(rowId)
    setNotice(null)
    try {
      await vouchersCall(eventId, body)
      setNotice({ card, text })
    } catch (err) {
      setNotice({ card, text: failure(err), error: true })
    } finally {
      await load()
      setBusyRow(null)
    }
  }

  const ask = (e, item) => setConfirm({ ...item, trigger: e.currentTarget })
  function closeConfirm() {
    const back = confirm?.trigger
    setConfirm(null)
    requestAnimationFrame(() => { if (back?.isConnected) back.focus() })
  }
  async function confirmed() {
    const { card, rowId, body, text } = confirm
    await act(card, rowId, body, text)
    setConfirm(null)
  }

  async function exportCsv() {
    setExporting(true)
    setNotice(null)
    try {
      const r = await vouchersCall(eventId, { action: 'export' })
      downloadCsv(r.data.filename, r.data.csv)
    } catch (err) {
      setNotice({ card: 'codes', text: failure(err), error: true })
    } finally {
      setExporting(false)
    }
  }

  // Closing a dialog gives the focus back to the button that opened it.
  const open = (kind, e, partner = null) => setDialog({ kind, partner, trigger: e.currentTarget })
  function close() {
    const back = dialog?.trigger
    setDialog(null)
    requestAnimationFrame(() => { if (back?.isConnected) back.focus() })
  }

  async function done(card, text) {
    close()
    setNotice({ card, text })
    await load()
  }

  const Notice = ({ card }) => (notice?.card === card ? (
    <p role={notice.error ? 'alert' : 'status'} data-testid={`${card}-notice`}
      className={`font-sans text-sm ${notice.error ? 'text-apex-red' : 'text-apex-yellow'}`}>{notice.text}</p>
  ) : null)

  if (state.status === 'loading') return <div className="h-24 bg-apex-surface-2 animate-pulse" aria-busy="true" />
  if (state.status === 'error') return <p className="text-apex-red text-sm">Nie udało się wczytać kodów rabatowych.</p>

  const codeActions = (v) => (
    <span className="inline-flex gap-1.5">
      {v.canDisable && (
        <button type="button" aria-label={`Wyłącz — ${v.code}`} className={ghostSmall} disabled={busyRow === v.id}
          onClick={() => act('codes', v.id, { action: 'disable', id: v.id }, `Wyłączono kod ${v.code}.`)}>Wyłącz</button>
      )}
      {v.canDelete && (
        <button type="button" aria-label={`Usuń — ${v.code}`} className={dangerSmall} disabled={busyRow === v.id}
          onClick={(e) => ask(e, { question: `Usunąć kod ${v.code}?`, card: 'codes', rowId: v.id, body: { action: 'delete', id: v.id }, text: `Usunięto kod ${v.code}.` })}>
          Usuń
        </button>
      )}
    </span>
  )

  const today = warsawToday()
  const rows = state.vouchers.map((v) => voucherView(v, { today }))

  return (
    <>
      <section className={cardClass} data-testid="vouchers">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <h2 className={cardTitle}>Kody rabatowe</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnGhost} onClick={(e) => open('code', e)}>+ Kod</button>
            <button type="button" className={btnGhost} onClick={(e) => open('generate', e)}>Wygeneruj kody</button>
            <button type="button" className={btnGhost} disabled={exporting || !rows.length} onClick={exportCsv}>Eksport CSV</button>
          </div>
        </div>
        <Notice card="codes" />
        {rows.length === 0 ? <p className="text-apex-muted text-sm" data-testid="vouchers-empty">Brak kodów.</p> : (
          <>
            {/* Under 640 px every code is a card, as the entries panel does: nothing is clipped (9b M-1). */}
            <ul className="sm:hidden flex flex-col gap-2" data-testid="voucher-cards">
              {rows.map((v) => (
                <li key={v.id} data-testid="voucher-card" className="border border-apex-border bg-apex-surface-2 p-3 flex flex-col gap-1.5 min-w-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-mono text-apex-text-bright [overflow-wrap:anywhere]">{v.code}</span>
                    <span className="font-mono text-sm whitespace-nowrap">{v.discount} · {v.uses}</span>
                  </div>
                  {v.state && <span className="font-mono text-[11px] text-apex-muted">{v.state}</span>}
                  <span className="font-mono text-xs uppercase text-apex-muted [overflow-wrap:anywhere]">PARTNER: {v.partner} · DO: {v.validUntil}</span>
                  {codeActions(v)}
                </li>
              ))}
            </ul>
            <div className="hidden sm:block relative overflow-x-auto max-w-full border border-apex-border">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={thClass}>Kod</th>
                    <th className={thClass}>Rabat</th>
                    <th className={thClass}>Użycia</th>
                    <th className={thClass}>Partner</th>
                    <th className={thClass}>Ważny do</th>
                    <th className={thClass}><span className="sr-only">Akcje</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id} data-testid="voucher-row" className={v.state ? 'text-apex-muted' : ''}>
                      <td className={`${tdClass} font-mono text-apex-text-bright whitespace-nowrap`}>
                        {v.code}
                        {v.state && <span className="block font-mono text-[11px] text-apex-muted">{v.state}</span>}
                      </td>
                      <td className={`${tdClass} font-mono whitespace-nowrap`}>{v.discount}</td>
                      <td className={`${tdClass} font-mono whitespace-nowrap`}>{v.uses}</td>
                      <td className={`${tdClass} min-w-[120px]`}>{v.partner}</td>
                      <td className={`${tdClass} font-mono whitespace-nowrap`}>{v.validUntil}</td>
                      <td className={`${tdClass} text-right`}>{codeActions(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className={cardClass} data-testid="partners">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <h2 className={cardTitle}>Partnerzy</h2>
          <button type="button" className={btnGhost} onClick={(e) => open('partner', e)}>+ Partner</button>
        </div>
        <Notice card="partners" />
        {state.partners.length === 0 ? <p className="text-apex-muted text-sm" data-testid="partners-empty">Brak partnerów.</p> : (
          <ul className="flex flex-col border border-apex-border">
            {state.partners.map((p) => (
              <li key={p.id} data-testid="partner-row"
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 border-b border-apex-border last:border-b-0">
                <span className="min-w-0">
                  <span className="block font-sans font-semibold text-base text-apex-text-bright [overflow-wrap:anywhere]">{p.name}</span>
                  {p.note && <span className="block font-sans text-sm text-apex-muted [overflow-wrap:anywhere]">{p.note}</span>}
                </span>
                <span className="inline-flex gap-1.5 shrink-0">
                  <button type="button" aria-label={`Zmień — ${p.name}`} className={ghostSmall} disabled={busyRow === p.id}
                    onClick={(e) => open('partner', e, p)}>Zmień</button>
                  <button type="button" aria-label={`Usuń — ${p.name}`} className={dangerSmall} disabled={busyRow === p.id}
                    onClick={(e) => ask(e, { question: `Usunąć partnera ${p.name}?`, card: 'partners', rowId: p.id, body: { action: 'partner_delete', id: p.id }, text: `Usunięto partnera ${p.name}.` })}>Usuń</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(dialog?.kind === 'code' || dialog?.kind === 'generate') && (
        <CodeDialog eventId={eventId} generate={dialog.kind === 'generate'} partners={state.partners} competitions={shown}
          onClose={close} onDone={(text) => done('codes', text)} />
      )}
      {confirm && <ConfirmDelete question={confirm.question} busy={busyRow === confirm.rowId} onYes={confirmed} onNo={closeConfirm} />}
      {dialog?.kind === 'partner' && (
        <PartnerForm eventId={eventId} partner={dialog.partner ?? null} onClose={close} onDone={(text) => done('partners', text)} />
      )}
    </>
  )
}
