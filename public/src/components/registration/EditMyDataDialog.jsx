import { useEffect, useId, useState } from 'react'
import { callFunction } from '../../lib/auth.js'
import { btnPrimary } from '../../pages/klub/settingsUi.js'
import EntryDialog from '../../pages/klub/wydarzenia/entries/EntryDialog.jsx'
import PersonEditFields, { changedFields, initialPerson } from './PersonEditFields.jsx'

// The runner's own „Popraw dane” (Moje zapisy, spec Part 2): my-entry-action `details` prefills the
// event form's fields except the names and the e-mail (those stay with the club), `edit` sends only
// what changed. A birth date or gender change re-checks the competition's ages on the server; its
// refusal (ineligible, an adult's entry turning into a child's, …) shows here, under the field or
// above the buttons.

/**
 * @param {{ entry: { id: string, name: string }, onClose: () => void, onDone: (r: { text: string }) => void }} p
 */
export default function EditMyDataDialog({ entry, onClose, onDone }) {
  const ids = useId()
  const [loaded, setLoaded] = useState({ status: 'loading' })
  const [value, setValue] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({})

  useEffect(() => {
    let active = true
    callFunction('my-entry-action', { action: 'details', registrationId: entry.id })
      .then((r) => {
        if (!active) return
        const d = r.data ?? {}
        setLoaded({ status: 'ok', person: d.person ?? {}, formFields: d.formFields ?? {}, start: initialPerson(d.person ?? {}, { names: false }) })
        setValue(initialPerson(d.person ?? {}, { names: false }))
      })
      .catch((err) => {
        if (!active) return
        setLoaded({ status: 'error' })
        setError(err.status == null ? 'Brak połączenia.' : err.message)
      })
    return () => { active = false }
  }, [entry.id])

  async function save() {
    const changed = changedFields(loaded.start, value)
    if (!Object.keys(changed).length) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    setFields({})
    try {
      await callFunction('my-entry-action', { action: 'edit', registrationId: entry.id, fields: changed })
      onDone({ text: `Zapisano zmiany — ${entry.name}.` })
    } catch (err) {
      if (err.fields) setFields(err.fields)
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
    }
  }

  return (
    <EntryDialog testId="my-edit-dialog" title="Popraw dane" subtitle={entry.name} busy={busy} onClose={onClose} wide
      error={error && !Object.keys(fields).length ? error : null}
      actions={loaded.status === 'ok'
        ? <button type="button" className={btnPrimary} disabled={busy} onClick={save}>Zapisz</button>
        : null}>
      {loaded.status === 'loading' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 bg-apex-surface-2" />)}</div>
      )}
      {loaded.status === 'ok' && value && (
        <PersonEditFields idPrefix={ids} value={value} onChange={setValue} fields={fields} busy={busy}
          formFields={loaded.formFields} stored={loaded.person} />
      )}
      {loaded.status === 'ok' && (
        <p className="font-sans text-sm text-apex-muted">Imię, nazwisko i adres e-mail zmienia organizator.</p>
      )}
    </EntryDialog>
  )
}
