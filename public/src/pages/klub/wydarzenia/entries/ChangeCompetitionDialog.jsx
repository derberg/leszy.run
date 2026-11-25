import { useEffect, useState } from 'react'
import { formatPln } from '@registration/money.js'
import { callFunction } from '../../../../lib/auth.js'
import { btnDanger, btnPrimary } from '../../settingsUi.js'
import EntryDialog from './EntryDialog.jsx'
import CompetitionTargetList, { TargetsLoading, differenceText } from '../../../../components/registration/CompetitionTargetList.jsx'

// ⋯ „Zmień konkurencję” (B3): organizer-entry-action change_competition_preview lists every other
// visible individual competition at change_competition's own numbers (the order's frozen tier, the
// voucher where it is offered); the organizer picks one and change_competition moves the entry.
// The same price moves at once; a cheaper one moves and refunds the difference through dpay (an
// order paid outside the system: the club gives it back by hand, „Różnicę zwracam poza systemem”);
// a dearer one creates a surcharge the payer pays online, and the entry moves when it is paid.
// One requestKey per dialog, so a request repeated after a lost answer is a replay. A refused
// change (409 price_changed with the real difference) re-reads the targets and asks again; a 409
// carrying data.moved means the entry moved and only the refund failed, so the dialog closes on it.

const newKey = () => crypto.randomUUID()

/** What the panel says once the change went through. */
function doneText(row, target, r) {
  const head = `Zmieniono konkurencję: ${row.name} → ${target.name}.`
  const d = r.data ?? {}
  switch (d.outcome) {
    case 'surcharge':
      return d.emailed === false
        ? `${row.name}: zmiana na ${target.name} czeka na dopłatę ${formatPln(d.grosze)}. Nie udało się wysłać e-maila — użyj „Przypomnij o dopłacie”.`
        : `${row.name}: zmiana na ${target.name} czeka na dopłatę ${formatPln(d.grosze)}. Wysłaliśmy prośbę o dopłatę.`
    case 'moved_offline_refund': return `${head} Zwróć ${formatPln(d.grosze)} poza systemem.`
    case 'refund': return d.status === 'accepted' ? `${head} Zwrócono ${formatPln(d.grosze)}.` : `${head} ${r.message ?? 'Zwrot niepotwierdzony.'}`
    default: return head
  }
}

export default function ChangeCompetitionDialog({ row, onClose, onDone, onFailed }) {
  const [preview, setPreview] = useState({ status: 'loading', targets: [] })
  const [categoryId, setCategoryId] = useState(null)
  const [ack, setAck] = useState(false)
  const [key, setKey] = useState(newKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function read({ keep = null } = {}) {
    try {
      const r = await callFunction('organizer-entry-action', { action: 'change_competition_preview', registrationId: row.id })
      const targets = r.data?.targets ?? []
      setPreview({ status: 'ok', targets })
      const still = targets.find((t) => t.categoryId === keep && t.eligible)
      setCategoryId(still ? still.categoryId : (targets.find((t) => t.eligible)?.categoryId ?? null))
      return targets
    } catch (err) {
      setPreview({ status: 'error', targets: [] })
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      return null
    }
  }

  useEffect(() => { read() }, [row.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const target = preview.targets.find((t) => t.categoryId === categoryId) ?? null
  const needsAck = Boolean(target?.offlineAck)

  async function change() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction('organizer-entry-action', {
        action: 'change_competition', registrationId: row.id, categoryId: target.categoryId,
        expectedDifference: target.difference, requestKey: key, ...(needsAck ? { offlineAck: true } : {}),
      })
      onDone({ text: doneText(row, target, r) })
    } catch (err) {
      if (err.data?.moved) {
        // The entry moved; dpay did not take the refund of the difference.
        onDone({ text: err.message, error: true })
        return
      }
      // A refusal decided on the server spent nothing under this key; a lost answer keeps it (replay).
      if (err.status != null && err.status < 500) setKey(newKey())
      if (err.code === 'price_changed') {
        // The new amount is confirmed afresh, the offline refund's acknowledgement too.
        setAck(false)
        const targets = await read({ keep: target.categoryId })
        const now = targets?.find((t) => t.categoryId === target.categoryId)
        setError(now ? `Cena się zmieniła: teraz ${differenceText(now)}. Sprawdź i potwierdź ponownie.` : err.message)
      } else {
        setError(err.status == null ? 'Brak połączenia.' : err.message)
      }
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="change-competition-dialog" title="Zmień konkurencję" subtitle={`${row.name} · ${row.competition}`}
      busy={busy} onClose={onClose} error={error} wide
      actions={(
        <button type="button" className={btnPrimary} disabled={busy || !target || !target.eligible || (needsAck && !ack)} onClick={change}>
          Zmień konkurencję
        </button>
      )}>
      {preview.status === 'loading' && <TargetsLoading />}
      {preview.status === 'ok' && preview.targets.length === 0 && (
        <p className="text-apex-muted text-sm" data-testid="change-no-targets">Brak innych konkurencji.</p>
      )}
      {preview.targets.length > 0 && (
        <CompetitionTargetList targets={preview.targets} categoryId={categoryId} busy={busy}
          onPick={(id) => { setCategoryId(id); setAck(false); setError(null) }} />
      )}
      {needsAck && (
        <label className="flex items-start gap-2.5 font-sans text-base text-apex-text-bright cursor-pointer" data-testid="change-offline-ack">
          <input type="checkbox" checked={ack} disabled={busy} onChange={(e) => setAck(e.target.checked)} className="accent-apex-yellow w-4 h-4 mt-1 shrink-0" />
          <span>Różnicę zwracam poza systemem ({formatPln(-target.difference)})</span>
        </label>
      )}
    </EntryDialog>
  )
}

/** ⋯ „Anuluj dopłatę”: asks first; the entry stays where it is. */
export function SurchargeCancelDialog({ row, onClose, onDone, onFailed }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const s = row.surcharge

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await callFunction('organizer-entry-action', { action: 'surcharge_cancel', orderId: s.orderId })
      onDone({ text: `Anulowano dopłatę — ${row.name} zostaje w konkurencji ${row.competition}.` })
    } catch (err) {
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      setBusy(false)
      onFailed()
    }
  }

  return (
    <EntryDialog testId="surcharge-cancel-dialog" title="Anulować dopłatę?" subtitle={`${row.name} · ${row.competition} → ${s?.toCompetition ?? ''}`}
      busy={busy} onClose={onClose} error={error} closeLabel="Nie"
      actions={<button type="button" className={btnDanger} disabled={busy || !s} onClick={cancel}>Anuluj dopłatę</button>}>
      {s && <p className="font-mono text-sm text-apex-cyan">DOPŁATA · {formatPln(s.grosze)}</p>}
    </EntryDialog>
  )
}
