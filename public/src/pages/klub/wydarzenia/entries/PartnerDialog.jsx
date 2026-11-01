import { useId, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage } from './EntryDialog.jsx'

// ⋯ „Partner” (B3, Plan 7): attributes one live entry to one of the event's partners, or clears it,
// through organizer-entry-action `partner`. A hand-set partner overrides the voucher's for that
// entry. Organizer-only data: a partner never reaches a runner (V-38).

export default function PartnerDialog({ row, partners, onClose, onDone, onFailed }) {
  const ids = useId()
  const [picked, setPicked] = useState(row.partnerId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})
  const options = [{ id: '', name: 'Bez partnera' }, ...partners]

  async function save() {
    if (picked === (row.partnerId ?? '')) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    setFields({})
    try {
      await callFunction('organizer-entry-action', { action: 'partner', registrationId: row.id, partnerId: picked || null })
      const name = partners.find((p) => p.id === picked)?.name
      onDone({ text: name ? `Partner: ${name} — ${row.name}.` : `Bez partnera — ${row.name}.` })
    } catch (err) {
      if (err.fields) setFields(err.fields)
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="partner-dialog" title="Partner" subtitle={row.name} busy={busy} onClose={onClose}
      error={error && !Object.keys(fields).length ? error : null}
      actions={<button type="button" className={btnPrimary} disabled={busy} onClick={save}>Zapisz</button>}>
      <div role="radiogroup" aria-label="Partner" aria-invalid={fields.partnerId ? 'true' : undefined}
        aria-describedby={fields.partnerId ? `${ids}-err` : undefined} className="flex flex-col gap-1.5">
        {options.map((p) => (
          <label key={p.id || 'none'} className={`flex items-center gap-2.5 min-h-11 px-3 py-1.5 border cursor-pointer min-w-0 ${p.id === picked
            ? 'border-apex-yellow' : 'border-apex-border-mid'}`}>
            <input type="radio" name={`${ids}-partner`} value={p.id} checked={p.id === picked} disabled={busy}
              onChange={() => setPicked(p.id)} className="accent-apex-yellow w-4 h-4 shrink-0" />
            <span className="font-sans font-semibold text-base text-apex-text-bright [overflow-wrap:anywhere]">{p.name}</span>
          </label>
        ))}
      </div>
      <FieldMessage id={`${ids}-err`} message={fields.partnerId} />
    </EntryDialog>
  )
}
