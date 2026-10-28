import { useState, useEffect } from 'react'
import { getClubPayout, updateClubPayout } from '../../../lib/organizer.js'
import { groupIban } from '../../../lib/iban.js'
import { panelClass, panelTitle, formWidth, fieldLabel, fieldInput, errorClass, savedClass, btnPrimary } from '../settingsUi.js'

// "Dane do wypłat" in club settings. The owner edits; an admin sees the name
// and the account masked as "PL61 … 2874" (get-club-payout masks it server-side,
// so the full number never reaches an admin's browser).

const EMPTY = { legalName: '', nip: '', krs: '', iban: '', address: '' }
// `wide` spans both columns on desktop; NIP and KRS sit side by side. Numbers stay
// in the body font: a 32-character grouped IBAN in mono does not fit a 360 px screen.
const FIELDS = [
  { key: 'legalName', id: 'payout-legal-name', label: 'Nazwa podmiotu', maxLength: 200, wide: true },
  { key: 'nip', id: 'payout-nip', label: 'NIP', inputMode: 'numeric' },
  { key: 'krs', id: 'payout-krs', label: 'KRS', inputMode: 'numeric', optional: true },
  { key: 'iban', id: 'payout-iban', label: 'Numer rachunku', wide: true },
  { key: 'address', id: 'payout-address', label: 'Adres', maxLength: 300, wide: true },
]

function fromServer(d) {
  return d ? { legalName: d.legalName || '', nip: d.nip || '', krs: d.krs || '', iban: groupIban(d.iban), address: d.address || '' } : EMPTY
}

function ReadOnly({ payout }) {
  if (!payout) return <p className="font-sans text-sm text-apex-muted">Brak danych do wypłat.</p>
  return (
    <dl className={`space-y-4 ${formWidth}`}>
      <div>
        <dt className={fieldLabel}>Nazwa podmiotu</dt>
        <dd className="font-sans text-base font-medium text-apex-text-bright break-words">{payout.legalName}</dd>
      </div>
      <div>
        <dt className={fieldLabel}>Rachunek</dt>
        <dd className="font-mono text-base text-apex-text-bright">{payout.ibanMasked}</dd>
      </div>
    </dl>
  )
}

export default function PayoutDetails({ clubId, isOwner }) {
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [payout, setPayout] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let live = true
    getClubPayout(clubId)
      .then((d) => { if (live) { setPayout(d); setForm(fromServer(d)); setReady(true) } })
      .catch((err) => { if (live) { setLoadError(err.message); setReady(true) } })
    return () => { live = false }
  }, [clubId])

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await updateClubPayout(clubId, form)
      const d = await getClubPayout(clubId)
      setPayout(d)
      setForm(fromServer(d))
      setSaved(true)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section data-testid="payout-details" className={panelClass}>
      <h2 className={panelTitle}>Dane do wypłat</h2>
      {!ready ? (
        <p className="font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</p>
      ) : loadError ? (
        <p className={errorClass}>{loadError}</p>
      ) : !isOwner ? (
        <ReadOnly payout={payout} />
      ) : (
        <form onSubmit={save} className={formWidth}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
            {FIELDS.map((f) => (
              <div key={f.key} className={f.wide ? 'sm:col-span-2' : undefined}>
                <label htmlFor={f.id} className={fieldLabel}>{f.label}</label>
                <input id={f.id} type="text" value={form[f.key]} inputMode={f.inputMode} maxLength={f.maxLength}
                  required={!f.optional} autoComplete="off"
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  onBlur={f.key === 'iban' ? () => setForm((s) => ({ ...s, iban: groupIban(s.iban) })) : undefined}
                  className={`${fieldInput} tabular-nums`} />
              </div>
            ))}
          </div>
          {saveError && <p className={`${errorClass} mt-4`}>{saveError}</p>}
          <div className="flex flex-wrap items-center gap-3 mt-5">
            <button type="submit" disabled={saving} className={btnPrimary}>
              {saving ? 'Zapisywanie…' : 'Zapisz dane do wypłat'}
            </button>
            {saved && <span data-testid="payout-saved" className={savedClass}>Zapisano</span>}
          </div>
        </form>
      )}
    </section>
  )
}
