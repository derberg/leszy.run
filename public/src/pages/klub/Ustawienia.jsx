import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import useAuth from '../../hooks/useAuth.js'
import ClubLogoUpload from '../../components/ClubLogoUpload.jsx'
import { updateClub, deleteClub, transferOwnership } from '../../lib/clubs.js'
import {
  panelClass, dangerPanelClass, panelTitle, dangerPanelTitle, formWidth, fieldLabel, fieldInput,
  hintClass, errorClass, savedClass, btnPrimary, btnDanger, btnGhost,
} from './settingsUi.js'
import { useKlub } from './context.js'
import PayoutDetails from './sections/PayoutDetails.jsx'
import useOrganizerStatus from '../../hooks/useOrganizerStatus.js'
import { organizerFeaturesShown } from '../../lib/organizerGate.js'

// Club settings page. Edit form (name/slug/description/is_public + logo) is a
// labeled rework of the old profil/club/ManagePanel.jsx EditClubSection
// (lines 274-327); the transfer-ownership and delete-club logic (originally
// TransferOwnershipSection, lines 329-397, and DeleteClubSection, lines
// 400-446) was copied from ManagePanel.jsx and flattened directly into this
// component (owner-only), with delete's reload() swapped for a
// navigate('/profil/klub') since a deleted club has nothing left to reload.
// That file is deleted in a later task, so this page owns its own copy
// rather than importing from it.

// "Dane do wypłat" only for a club with online registration switched on.
function OrganizerPayout({ clubId, isOwner }) {
  const { status } = useOrganizerStatus(clubId)
  if (!organizerFeaturesShown(status)) return null
  return <PayoutDetails clubId={clubId} isOwner={isOwner} />
}

function displayNameFor(m) {
  return m?.display_name || m?.nickname || 'Uczestnik anonimowy'
}

export default function Ustawienia() {
  const { club, members, reload, canManage, isOwner } = useKlub()
  const { user } = useAuth()
  const navigate = useNavigate()

  useSeo({ title: `Ustawienia — ${club.name} — Leszy.run`, noindex: true })

  // All hooks below must run unconditionally (Rules of Hooks) even though
  // non-managers get redirected — the guard return happens after them.
  const [name, setName] = useState(club.name)
  const [description, setDescription] = useState(club.description || '')
  const [isPublic, setIsPublic] = useState(!!club.is_public)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)

  const [target, setTarget] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferError, setTransferError] = useState(null)

  const [confirming, setConfirming] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  if (!canManage) return <Navigate to={`/klub/${club.slug}/panel`} replace />

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const payload = { name: name.trim(), description: description.trim(), is_public: isPublic }
      await updateClub(club.id, payload)
      // No slug in the payload any more — the address is fixed, so the page
      // never has to survive a canonical-URL redirect after saving.
      await reload()
      setSaved(true)
    } catch (err) {
      setSaveError(/istnieje/i.test(err.message) ? 'Klub o tej nazwie już istnieje.' : err.message)
    } finally {
      setSaving(false)
    }
  }

  const activeMembers = (members ?? []).filter((m) => m.status === 'active')
  const candidates = activeMembers.filter((m) => m.user_id !== user?.id && m.role !== 'owner')
  const nominee = club.pending_owner_id ? activeMembers.find((m) => m.user_id === club.pending_owner_id) : null

  async function nominate() {
    if (!target) return
    setTransferBusy(true)
    setTransferError(null)
    try {
      await transferOwnership(club.id, 'nominate', target)
      await reload()
    } catch (err) {
      setTransferError(err.message)
    } finally {
      setTransferBusy(false)
    }
  }

  async function cancelNomination() {
    setTransferBusy(true)
    setTransferError(null)
    try {
      await transferOwnership(club.id, 'cancel')
      await reload()
    } catch (err) {
      setTransferError(err.message)
    } finally {
      setTransferBusy(false)
    }
  }

  async function doDelete() {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteClub(club.id)
      // Deleted — nothing left for this club's reload() to fetch; send the
      // (former) owner back to the club landing page.
      navigate('/profil/klub')
    } catch (err) {
      setDeleteError(err.message)
      setDeleteBusy(false)
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8 max-w-3xl">
      <section className={panelClass}>
        <h2 className={panelTitle}>Klub</h2>
        <div className="mb-6">
          <ClubLogoUpload clubId={club.id} currentUrl={club.logo_url} onUploaded={() => reload()} />
        </div>
        <form onSubmit={save} className={`space-y-5 ${formWidth}`}>
          <div>
            <label htmlFor="club-name" className={fieldLabel}>Nazwa klubu</label>
            <input id="club-name" data-testid="edit-club-name" type="text" value={name}
              onChange={(e) => setName(e.target.value)} maxLength={120}
              placeholder="np. Zatyrani Gratisownia" className={fieldInput} />
          </div>
          {/* Read-only: the address is fixed once the club is created. Changing
              it repoints every published link and parks the old one forever. */}
          <div>
            <label htmlFor="club-slug" className={fieldLabel}>Adres klubu</label>
            <div className="flex items-stretch min-w-0 border border-apex-border-mid bg-apex-surface-2 opacity-70 cursor-not-allowed">
              <span className="flex items-center font-mono text-sm text-apex-muted pl-3.5 shrink-0">leszy.run/klub/</span>
              <input id="club-slug" data-testid="edit-club-slug" type="text" value={club.slug}
                readOnly disabled
                className="flex-1 min-w-0 bg-transparent font-mono text-sm text-apex-text-bright py-2.5 pr-3.5 outline-none cursor-not-allowed" />
            </div>
            <p className={hintClass}>
              Adresu nie można zmienić. Napisz do nas, jeśli potrzebujesz zmiany.
            </p>
          </div>
          <div>
            <label htmlFor="club-description" className={fieldLabel}>Opis klubu</label>
            <textarea id="club-description" data-testid="edit-club-description" value={description}
              onChange={(e) => setDescription(e.target.value)} rows={4}
              placeholder="Napisz kilka zdań o klubie — kto biega, skąd jesteście, jak dołączyć…"
              className={`${fieldInput} resize-none`} />
          </div>
          {/* Parked, not removed: the public club page is off until it is worth
              showing, so the switch stays where owners already expect it and
              says why it does nothing. `isPublic` keeps the stored value, so
              saving anything else here does not silently flip it. */}
          <div>
            <label className="flex items-start gap-2.5 opacity-60 cursor-not-allowed">
              <input
                data-testid="toggle-club-public"
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                disabled
                className="accent-[#BBDD00] w-4 h-4 mt-0.5 shrink-0"
              />
              <span className="font-sans text-base font-medium text-apex-text leading-snug">Publiczna strona klubu widoczna dla wszystkich</span>
            </label>
            <p className={`${hintClass} pl-[26px]`}>
              Wkrótce — publiczna strona klubu jest w przygotowaniu.
            </p>
          </div>
          {saveError && <p className={errorClass}>{saveError}</p>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button type="submit" data-testid="save-club" disabled={saving} className={btnPrimary}>
              {saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
            </button>
            {saved && <span className={savedClass}>Zapisano</span>}
          </div>
        </form>
      </section>

      <OrganizerPayout clubId={club.id} isOwner={isOwner} />

      {isOwner && (
        <section className={panelClass}>
          <h2 className={panelTitle}>Właściciel</h2>
          {club.pending_owner_id ? (
            <div className={`flex flex-col sm:flex-row sm:items-center gap-3 ${formWidth}`}>
              <span className="flex-1 min-w-0 font-sans text-base text-apex-text">
                Oczekuje na akceptację: <strong className="text-apex-text-bright">{nominee ? displayNameFor(nominee) : 'nowy właściciel'}</strong>
              </span>
              <div>
                <button data-testid="cancel-nomination" onClick={cancelNomination} disabled={transferBusy} className={btnDanger}>
                  Anuluj nominację
                </button>
              </div>
            </div>
          ) : candidates.length === 0 ? (
            <p className="font-sans text-base text-apex-muted">Brak innych aktywnych członków do nominacji.</p>
          ) : (
            <div className={formWidth}>
              <label htmlFor="club-transfer-target" className={fieldLabel}>Przekaż własność</label>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <select
                  id="club-transfer-target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className={`${fieldInput} appearance-none cursor-pointer sm:flex-1`}
                >
                  <option value="">— wybierz członka —</option>
                  {candidates.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{displayNameFor(m)}</option>
                  ))}
                </select>
                <div>
                  <button data-testid={target ? `nominate-${target}` : 'nominate'} onClick={nominate} disabled={transferBusy || !target} className={btnPrimary}>
                    Nominuj na właściciela
                  </button>
                </div>
              </div>
            </div>
          )}
          {transferError && <p className={`${errorClass} mt-3`}>{transferError}</p>}
        </section>
      )}

      {isOwner && (
        <section className={dangerPanelClass}>
          <h2 className={dangerPanelTitle}>Usuń klub</h2>
          {!confirming ? (
            <button data-testid="delete-club-btn" onClick={() => setConfirming(true)} className={btnDanger}>
              Usuń klub
            </button>
          ) : (
            <div className={formWidth}>
              <p className="font-sans text-base text-apex-text-bright mb-4">
                Usunięcie klubu «{club.name}» jest nieodwracalne. Wszyscy członkowie stracą przypisanie do klubu.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button data-testid="confirm-delete-club" onClick={doDelete} disabled={deleteBusy} className={btnDanger}>
                  {deleteBusy ? 'Usuwanie…' : 'Tak, usuń klub'}
                </button>
                <button onClick={() => setConfirming(false)} disabled={deleteBusy} className={btnGhost}>Anuluj</button>
              </div>
            </div>
          )}
          {deleteError && <p className={`${errorClass} mt-3`}>{deleteError}</p>}
        </section>
      )}
    </div>
  )
}
