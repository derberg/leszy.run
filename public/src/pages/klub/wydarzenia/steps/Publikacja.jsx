import { useState } from 'react'
import { Link } from 'react-router-dom'
import { publishRegistrationEvent } from '../../../../lib/organizer.js'
import { stepForBlocking } from '../../../../lib/wizardSteps.js'
import { countLabel } from '../../../../lib/categoryRows.js'
import { btnGhost, btnPrimary } from '../../settingsUi.js'
import { useKlub } from '../../context.js'
import { cardClass, cardTitle } from '../wizardUi.jsx'

// A7: the checklist (blocking items stop publishing, missing ones do not),
// the runner preview for club members, and publish.

const warsawDay = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric' })
const KONKURENCJE = ['konkurencja', 'konkurencje', 'konkurencji']
const KATEGORIE = ['kategoria wiekowa', 'kategorie wiekowe', 'kategorii wiekowych']
const GRUPY = ['grupa dzieci', 'grupy dzieci', 'grup dzieci']

function Check({ label, mark, tone, to, testId }) {
  const color = tone === 'red' ? 'text-apex-red' : tone === 'cyan' ? 'text-apex-cyan' : 'text-apex-yellow'
  return (
    <div className="flex justify-between items-center gap-2.5 py-2 border-b border-apex-border text-[17px] text-apex-text-bright" data-testid={testId}>
      <span className="min-w-0">{label}</span>
      {to
        ? <Link to={to} className={`font-mono text-sm whitespace-nowrap no-underline hover:underline ${color}`}>{mark}</Link>
        : <span className={`font-mono text-sm whitespace-nowrap ${color}`}>{mark}</span>}
    </div>
  )
}

export default function Publikacja({ event, readOnly, reload, base }) {
  const { club } = useKlub()
  const s = event.settings
  const { blocking, missing } = event.checklist ?? { blocking: [], missing: [] }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const previewPath = `${base}/podglad`
  const visible = (event.competitions ?? []).filter((c) => !c.hiddenAt)
  const blocked = new Set(blocking.map((b) => b.key))
  const adultGroups = new Set((event.ageGroups ?? []).map((g) => `${g.gender}|${g.label}`)).size
  const kidsGroups = (event.kidsGroups ?? []).length
  const opensLabel = s.opensAt ? warsawDay.format(new Date(s.opensAt)) : null
  const published = s.state !== 'draft'

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${previewPath}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  async function publish() {
    setBusy(true)
    setError(null)
    try {
      await publishRegistrationEvent(s.eventId)
      await reload()
    } catch (err) {
      setError(err.message)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 min-w-0">
      <section className={`${cardClass} max-w-[720px]`} data-testid="checklist">
        <h2 className={cardTitle}>Sprawdzenie</h2>
        <div>
          {!blocked.has('competitions') && visible.length > 0 && (
            <Check label={countLabel(visible.length, KONKURENCJE)} mark="✓" />
          )}
          {(adultGroups > 0 || kidsGroups > 0) && (
            <Check label={[adultGroups && countLabel(adultGroups, KATEGORIE), kidsGroups && countLabel(kidsGroups, GRUPY)].filter(Boolean).join(' + ')} mark="✓" />
          )}
          {!blocked.has('regulamin') && (
            <Check label={`Regulamin zawodów (${s.regulaminKind === 'link' ? 'link' : 'PDF'})`} mark="✓" />
          )}
          {!blocked.has('contact_email') && <Check label={`E-mail kontaktowy · ${s.contactEmail}`} mark="✓" />}
          {blocking.map((b) => (
            <Check key={b.key} label={b.label} mark="UZUPEŁNIJ ✗" tone="red" testId="blocking-item"
              to={readOnly ? null : `${base}/${stepForBlocking(b.key)}`} />
          ))}
          {missing.map((m) => (
            <Check key={m.key} label={m.label} mark="UZUPEŁNIJ" tone="cyan" testId="missing-item" to={readOnly ? null : `${base}/${m.step}`} />
          ))}
        </div>
        <div className="flex gap-2.5 flex-wrap mt-1.5">
          <Link to={previewPath} className={`${btnGhost} no-underline inline-block`}>Podgląd jako zawodnik</Link>
          <button type="button" className={btnGhost} onClick={copyLink}>{copied ? 'Skopiowano' : 'Kopiuj link podglądu'}</button>
        </div>
        <span className="font-mono text-xs text-apex-muted uppercase -mt-1">Link działa tylko dla członków {club.name}</span>
      </section>

      {published && (
        <p className="font-mono text-sm text-apex-yellow" data-testid="published">
          OPUBLIKOWANE · <a href={`/events/${s.slug}`} target="_blank" rel="noreferrer" className="underline">Strona zawodów ↗</a>
        </p>
      )}
      {error && <p role="alert" className="text-apex-red font-sans text-sm">{error}</p>}
      {!readOnly && !published && (
        <div className="flex justify-end">
          <button type="button" className={btnPrimary} disabled={busy || blocking.length > 0} onClick={publish}>
            {busy ? 'Publikowanie…' : opensLabel ? `Opublikuj · zapisy od ${opensLabel}` : 'Opublikuj'}
          </button>
        </div>
      )}
    </div>
  )
}
