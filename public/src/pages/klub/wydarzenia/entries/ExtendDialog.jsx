import { useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { extendChoices } from '../../../../lib/entriesModel.js'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog from './EntryDialog.jsx'

// „Przedłuż termin wpłaty” (B3): the order's payment deadline moves 7 or 14 days past the current
// one, or to the close of registration, each capped at closes_at (ruling 2, user decision) and at
// 14 days from now, which is as far as extend_order_window goes. It never shortens the deadline,
// so a choice that would not move it forward is offered disabled. The extension holds no place
// (D6-13, P3-R15).

const warsawDateTime = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: 'numeric', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

export default function ExtendDialog({ row, closesAt, onClose, onDone, onFailed }) {
  const [choices] = useState(() => extendChoices({ expiresAt: row.expiresAt, closesAt }))
  const [picked, setPicked] = useState(() => choices.find((c) => c.until)?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const choice = choices.find((c) => c.id === picked)

  async function extend() {
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction('organizer-entry-action', { action: 'extend', registrationId: row.id, until: choice.until.toISOString() })
      onDone({ text: `Nowy termin wpłaty: ${warsawDateTime.format(new Date(r.data.expiresAt))} — ${row.name}.` })
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="extend-dialog" title="Przedłuż termin wpłaty" subtitle={row.name} busy={busy} onClose={onClose} error={error}
      actions={(
        <button type="button" className={btnPrimary} disabled={busy || !choice?.until} onClick={extend}>Przedłuż</button>
      )}>
      {row.expiresAt && (
        <p className="font-mono text-sm text-apex-muted">TERMIN: {warsawDateTime.format(new Date(row.expiresAt))}</p>
      )}
      <div role="radiogroup" aria-label="Nowy termin" className="flex flex-col gap-1.5">
        {choices.map((c) => (
          <label key={c.id} className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 min-h-11 px-3 py-1.5 border ${c.id === picked
            ? 'border-apex-yellow' : 'border-apex-border-mid'} ${c.until ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
            <span className="flex items-center gap-2.5">
              <input type="radio" name="extend-until" value={c.id} checked={c.id === picked} disabled={!c.until || busy}
                onChange={() => setPicked(c.id)} className="accent-apex-yellow w-4 h-4" />
              <span className="font-sans font-semibold text-base text-apex-text-bright whitespace-nowrap">{c.label}</span>
            </span>
            <span className="font-mono text-sm text-apex-muted whitespace-nowrap">{c.until ? warsawDateTime.format(c.until) : '—'}</span>
          </label>
        ))}
      </div>
      <p className="font-sans text-sm text-apex-cyan">Przedłużenie nie rezerwuje miejsca.</p>
    </EntryDialog>
  )
}
