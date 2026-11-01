import { useEffect, useId, useRef, useState } from 'react'
import { callFunction } from '../../../../lib/auth.js'
import { pluralPl } from '../../../../lib/plural.js'
import { btnGhost, btnPrimary } from '../../settingsUi.js'
import EntryDialog, { FieldMessage, dialogInput, dialogLabel } from './EntryDialog.jsx'

// B3a: the organizer writes to the event's participants through send-organizer-message, as
// „<klub> przez LESZY.RUN”, replies to the event's contact address (P2-R19). „Wiadomość do
// uczestników” picks the audience (competitions, status, teams); „Napisz do zawodnika” /
// „Napisz do kapitana” writes to that one entry. „DO N OSÓB” is the server's `preview` count for
// the current audience, re-asked on every change; „Wyślij test do mnie” sends to the caller only.

const STATUSES = [['confirmed', 'Na liście (opłaceni)'], ['awaiting', 'Czeka na wpłatę'], ['all', 'Wszyscy zgłoszeni']]
const TEAMS = [['members', 'Wszyscy członkowie'], ['captains', 'Tylko kapitanowie']]

const peopleTo = (n) => `DO ${n} ${pluralPl(n, 'OSOBY', 'OSÓB', 'OSÓB')}`

function Choice({ on, onClick, children, disabled }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} disabled={disabled}
      className={`min-h-9 px-3 border font-sans font-semibold text-sm whitespace-nowrap disabled:opacity-40 ${on
        ? 'border-apex-yellow bg-apex-surface-2 text-apex-yellow'
        : 'border-apex-border-bright text-apex-text hover:border-apex-yellow-dim hover:text-apex-text-bright'}`}>
      {children}
    </button>
  )
}

function Group({ label, children }) {
  const id = useId()
  return (
    <div className="min-w-0">
      <span id={id} className={dialogLabel}>{label}</span>
      <div role="group" aria-labelledby={id} className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

/**
 * @param {{ eventId: string, row: object|null, isTeamRow: boolean, team: object|null,
 *   competitions: { id: string, name: string, kind: string }[], clubName: string|null,
 *   contactEmail: string|null, onClose: () => void, onDone: (notice: object) => void, onFailed: () => void }} props
 */
export default function MessageDialog({ eventId, row, isTeamRow, team, competitions, clubName, contactEmail, onClose, onDone, onFailed }) {
  const ids = useId()
  const single = row != null
  const [categoryIds, setCategoryIds] = useState([])
  const [status, setStatus] = useState('confirmed')
  const [teams, setTeams] = useState('members')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [count, setCount] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  // The count's own failure, kept apart from a send's: each new count clears it.
  const [previewError, setPreviewError] = useState(null)
  const [fields, setFields] = useState({})
  const [tested, setTested] = useState(false)
  const asked = useRef(0)
  const hasTeams = competitions.some((c) => c.kind === 'team')

  const target = single ? { registrationId: row.id } : { eventId, audience: { categoryIds, status, teams } }

  useEffect(() => {
    const n = ++asked.current
    setCount(null)
    setPreviewError(null)
    callFunction('send-organizer-message', { ...target, mode: 'preview' })
      .then((r) => { if (n === asked.current) setCount(r.data.count) })
      .catch((err) => { if (n === asked.current) setPreviewError(err.status == null ? 'Brak połączenia.' : err.message) })
  // The audience is the whole dependency: categoryIds is a new array only when it changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, row?.id, categoryIds, status, teams])

  const toggleCategory = (id) => setCategoryIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))

  async function post(mode) {
    setBusy(mode)
    setError(null)
    setFields({})
    setTested(false)
    try {
      const r = await callFunction('send-organizer-message', { ...target, mode, subject, body: text })
      if (mode === 'test') {
        setTested(true)
        setBusy(null)
        return
      }
      const { recipientCount, failed } = r.data
      onDone({
        text: `Wysłano ${peopleTo(recipientCount).toLowerCase()}.${failed ? ` Nie wysłano: ${failed}.` : ''}`,
        error: failed > 0,
      })
    } catch (err) {
      if (err.fields) setFields(err.fields)
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(null)
      if (mode === 'send') onFailed()
    }
  }

  const title = single ? (isTeamRow ? 'Napisz do kapitana' : 'Napisz do zawodnika') : 'Wiadomość do uczestników'
  const subtitle = single ? (isTeamRow && team ? `${team.name} · kapitan: ${team.captain ?? row.name}` : row.name) : null

  return (
    <EntryDialog testId="message-dialog" title={title} subtitle={subtitle} busy={busy != null} onClose={onClose} wide
      error={(error && !Object.keys(fields).length ? error : null) ?? previewError}
      actions={(
        <>
          <button type="button" className={btnGhost} disabled={busy != null} onClick={() => post('test')}>Wyślij test do mnie</button>
          <button type="button" className={btnPrimary} disabled={busy != null || !count} onClick={() => post('send')}>Wyślij</button>
        </>
      )}>
      {!single && (
        <div className="flex flex-col gap-3">
          <Group label="Do kogo">
            <Choice on={categoryIds.length === 0} onClick={() => setCategoryIds([])} disabled={busy != null}>Wszystkie</Choice>
            {competitions.map((c) => (
              <Choice key={c.id} on={categoryIds.includes(c.id)} onClick={() => toggleCategory(c.id)} disabled={busy != null}>{c.name}</Choice>
            ))}
          </Group>
          <Group label="Status">
            {STATUSES.map(([key, label]) => (
              <Choice key={key} on={status === key} onClick={() => setStatus(key)} disabled={busy != null}>{label}</Choice>
            ))}
          </Group>
          {hasTeams && (
            <Group label="Drużyny">
              {TEAMS.map(([key, label]) => (
                <Choice key={key} on={teams === key} onClick={() => setTeams(key)} disabled={busy != null}>{label}</Choice>
              ))}
            </Group>
          )}
        </div>
      )}
      <div className="min-w-0">
        <label htmlFor={`${ids}-subject`} className={dialogLabel}>Temat</label>
        <input id={`${ids}-subject`} value={subject} maxLength={150} disabled={busy != null} onChange={(e) => setSubject(e.target.value)}
          aria-invalid={fields.subject ? 'true' : undefined} aria-describedby={fields.subject ? `${ids}-subject-err` : undefined}
          className={`${dialogInput} ${fields.subject ? 'border-apex-red' : ''}`} />
        <FieldMessage id={`${ids}-subject-err`} message={fields.subject} />
      </div>
      <div className="min-w-0">
        <label htmlFor={`${ids}-body`} className={dialogLabel}>Treść</label>
        <textarea id={`${ids}-body`} rows={7} value={text} maxLength={5000} disabled={busy != null} onChange={(e) => setText(e.target.value)}
          aria-invalid={fields.body ? 'true' : undefined} aria-describedby={fields.body ? `${ids}-body-err` : undefined}
          className={`${dialogInput} resize-y ${fields.body ? 'border-apex-red' : ''}`} />
        <FieldMessage id={`${ids}-body-err`} message={fields.body} />
      </div>
      <dl className="font-mono text-sm text-apex-muted flex flex-col gap-0.5 min-w-0">
        <div className="[overflow-wrap:anywhere]"><dt className="inline">Od: </dt><dd className="inline text-apex-text">{clubName ?? '—'} przez LESZY.RUN</dd></div>
        <div className="[overflow-wrap:anywhere]"><dt className="inline">Odpowiedzi na: </dt><dd className="inline text-apex-text">{contactEmail ?? '—'}</dd></div>
      </dl>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-mono text-base text-apex-yellow" data-testid="message-count" aria-live="polite">
          {count == null ? '…' : peopleTo(count)}
        </span>
        {tested && <span role="status" className="font-mono text-sm text-apex-yellow">Test wysłany.</span>}
      </div>
    </EntryDialog>
  )
}
