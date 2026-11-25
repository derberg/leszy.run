import { useEffect, useState } from 'react'
import { formatPln } from '@registration/money.js'
import { changeRefusal } from '@registration/competitionChange.js'
import { callFunction } from '../../lib/auth.js'
import { btnPrimary } from '../../pages/klub/settingsUi.js'
import EntryDialog from '../../pages/klub/wydarzenia/entries/EntryDialog.jsx'
import CompetitionTargetList, { TargetsLoading, differenceText } from './CompetitionTargetList.jsx'

// The runner's own „Zmień konkurencję” (Moje zapisy, spec Part 2): my-entry-action `targets` lists
// the other competitions at change_competition's numbers, `change` moves the entry. The same price
// moves at once; a cheaper one moves and the difference goes back to the payer; a dearer one is a
// surcharge the runner pays right away (onDone gets its orderId and the page opens the order). An
// entry that cannot move (the club's switch, a refund or a transfer in progress, …) shows why, and
// nothing to pick. One requestKey per dialog, so a request repeated after a lost answer is a replay.

const newKey = () => crypto.randomUUID()

function refusalText(code) {
  try { return changeRefusal(code, { runner: true }).error } catch { return 'Zmiana konkurencji jest niemożliwa.' }
}

function doneText(target, r) {
  const head = `Zmieniono konkurencję na ${target.name}.`
  const d = r.data ?? {}
  if (d.outcome !== 'refund') return head
  return d.status === 'accepted' ? `${head} Zwrot ${formatPln(d.grosze)} trafi do osoby, która zapłaciła.` : `${head} ${r.message ?? 'Zwrot w toku.'}`
}

/**
 * @param {{ entry: { id: string, name: string, competition: string|null }, onClose: () => void,
 *   onDone: (r: { text?: string, error?: boolean, surchargeOrderId?: string }) => void }} p
 */
export default function ChangeMyCompetitionDialog({ entry, onClose, onDone }) {
  const [preview, setPreview] = useState({ status: 'loading', targets: [], refusal: null })
  const [categoryId, setCategoryId] = useState(null)
  const [key, setKey] = useState(newKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function read({ keep = null } = {}) {
    try {
      const r = await callFunction('my-entry-action', { action: 'targets', registrationId: entry.id })
      const d = r.data ?? {}
      const targets = d.allowed ? (d.targets ?? []) : []
      setPreview({ status: 'ok', targets, refusal: d.allowed ? null : (d.refusal ?? 'not_allowed') })
      const still = targets.find((t) => t.categoryId === keep && t.eligible)
      setCategoryId(still ? still.categoryId : (targets.find((t) => t.eligible)?.categoryId ?? null))
      return targets
    } catch (err) {
      setPreview({ status: 'error', targets: [], refusal: null })
      setError(err.status == null ? 'Brak połączenia.' : err.message)
      return null
    }
  }

  useEffect(() => { read() }, [entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const target = preview.targets.find((t) => t.categoryId === categoryId) ?? null

  async function change() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction('my-entry-action', {
        action: 'change', registrationId: entry.id, categoryId: target.categoryId,
        expectedDifference: target.difference, requestKey: key,
      })
      if (r.data?.outcome === 'surcharge' && r.data.orderId) onDone({ surchargeOrderId: r.data.orderId })
      else onDone({ text: doneText(target, r) })
    } catch (err) {
      if (err.data?.moved) {
        // The entry moved; dpay did not take the refund of the difference.
        onDone({ text: err.message, error: true })
        return
      }
      // A refusal decided on the server spent nothing under this key; a lost answer keeps it (replay).
      if (err.status != null && err.status < 500) setKey(newKey())
      if (err.code === 'price_changed') {
        const targets = await read({ keep: target.categoryId })
        const now = targets?.find((t) => t.categoryId === target.categoryId)
        setError(now ? `Cena się zmieniła: teraz ${differenceText(now)}. Sprawdź i potwierdź ponownie.` : err.message)
      } else {
        setError(err.status == null ? 'Brak połączenia.' : err.message)
      }
      setBusy(false)
    }
  }

  const label = target?.kind === 'surcharge' ? 'Zmień i zapłać' : 'Zmień konkurencję'
  return (
    <EntryDialog testId="my-change-dialog" title="Zmień konkurencję" subtitle={[entry.name, entry.competition].filter(Boolean).join(' · ')}
      busy={busy} onClose={onClose} error={error} wide
      actions={preview.refusal ? null : (
        <button type="button" className={btnPrimary} disabled={busy || !target || !target.eligible} onClick={change}>{label}</button>
      )}>
      {preview.status === 'loading' && <TargetsLoading />}
      {preview.refusal && (
        <p className="font-sans text-base text-apex-text-bright" data-testid="my-change-refusal">{refusalText(preview.refusal)}</p>
      )}
      {preview.status === 'ok' && !preview.refusal && preview.targets.length === 0 && (
        <p className="text-apex-muted text-sm" data-testid="change-no-targets">Brak innych konkurencji.</p>
      )}
      {preview.targets.length > 0 && (
        <CompetitionTargetList targets={preview.targets} categoryId={categoryId} busy={busy}
          onPick={(id) => { setCategoryId(id); setError(null) }} />
      )}
    </EntryDialog>
  )
}
