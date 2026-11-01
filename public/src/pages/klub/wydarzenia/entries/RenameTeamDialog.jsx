import { useId, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from './EntryDialog.jsx'

// „Zmień nazwę drużyny” (B3): organizer-entry-action rename_team. The server owns the name rules
// (teamNameKey, 2–40 characters, unique per competition among live teams) and answers with `fields`.

export default function RenameTeamDialog({ team, onClose, onDone, onFailed }) {
  const id = useId()
  const [name, setName] = useState(team.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function rename() {
    if (name.trim() === team.name) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction('organizer-entry-action', { action: 'rename_team', teamId: team.id, name })
      onDone({ text: `Nowa nazwa drużyny: ${r.data.name}.` })
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : (err.fields?.name ?? err.message))
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="rename-dialog" title="Zmień nazwę drużyny" subtitle={`${team.name} · ${team.size} os.`} busy={busy} onClose={onClose}
      actions={<button type="button" className={btnPrimary} disabled={busy || !name.trim()} onClick={rename}>Zapisz</button>}>
      <div className="min-w-0">
        <label htmlFor={id} className={dialogLabel}>Nazwa drużyny</label>
        <input id={id} value={name} maxLength={60} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') rename() }}
          aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-err` : undefined}
          className={`${dialogInput} ${error ? 'border-apex-red' : ''}`} />
        <FieldMessage id={`${id}-err`} message={error} />
      </div>
    </EntryDialog>
  )
}
