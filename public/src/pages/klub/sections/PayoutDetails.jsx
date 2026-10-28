import { useState, useEffect } from 'react'
import { getClubPayout, updateClubPayout } from '../../../lib/organizer.js'
import { sectionTitle, primaryBtnClass } from '../../profil/fields.jsx'

// "Dane do wypłat" in club settings. The owner edits; an admin sees the name
// and the account masked as "PL61 … 2874" (get-club-payout masks it server-side,
// so the full number never reaches an admin's browser).

const fieldLabel = 'block font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1'
const fieldInput = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-base md:text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'

const EMPTY = { legalName: '', nip: '', krs: '', iban: '', address: '' }
const FIELDS = [
  { key: 'legalName', id: 'payout-legal-name', label: 'Nazwa podmiotu', maxLength: 200 },
  { key: 'nip', id: 'payout-nip', label: 'NIP', inputMode: 'numeric' },
  { key: 'krs', id: 'payout-krs', label: 'KRS', inputMode: 'numeric', optional: true },
  { key: 'iban', id: 'payout-iban', label: 'Numer rachunku' },
  { key: 'address', id: 'payout-address', label: 'Adres', maxLength: 300 },
]

function fromServer(d) {
  return d ? { legalName: d.legalName || '', nip: d.nip || '', krs: d.krs || '', iban: d.iban || '', address: d.address || '' } : EMPTY
}

function ReadOnly({ payout }) {
  if (!payout) return <p className="font-sans text-xs text-apex-muted">Brak danych do wypłat.</p>
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      <dt className="font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted self-center">Nazwa podmiotu</dt>
      <dd className="font-sans text-apex-text-bright">{payout.legalName}</dd>
      <dt className="font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted self-center">Rachunek</dt>
      <dd className="font-mono text-apex-text-bright">{payout.ibanMasked}</dd>
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
    <div data-testid="payout-details">
      <div className={sectionTitle}>Dane do wypłat</div>
      {!ready ? (
        <p className="font-mono text-xs text-apex-muted animate-pulse">Ładowanie…</p>
      ) : loadError ? (
        <p className="text-apex-red font-sans text-xs">{loadError}</p>
      ) : !isOwner ? (
        <ReadOnly payout={payout} />
      ) : (
        <form onSubmit={save} className="space-y-3 max-w-sm">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={f.id} className={fieldLabel}>{f.label}</label>
              <input id={f.id} type="text" value={form[f.key]} inputMode={f.inputMode} maxLength={f.maxLength}
                required={!f.optional} autoComplete="off"
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className={f.key === 'iban' || f.key === 'nip' || f.key === 'krs' ? `${fieldInput} font-mono` : fieldInput} />
            </div>
          ))}
          {saveError && <p className="text-apex-red font-sans text-xs">{saveError}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={saving} className={primaryBtnClass}>
              {saving ? 'Zapisywanie…' : 'Zapisz dane do wypłat'}
            </button>
            {saved && <span data-testid="payout-saved" className="font-mono text-xs text-apex-yellow">Zapisano</span>}
          </div>
        </form>
      )}
    </div>
  )
}
