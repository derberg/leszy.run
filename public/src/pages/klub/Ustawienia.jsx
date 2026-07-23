import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import useSeo from '../../hooks/useSeo.js'
import useAuth from '../../hooks/useAuth.js'
import ClubLogoUpload from '../../components/ClubLogoUpload.jsx'
import { updateClub, deleteClub, transferOwnership } from '../../lib/clubs.js'
import { sectionTitle, actionBtnClass, inputClass } from '../profil/fields.jsx'
import { useKlub } from './context.js'

// Club settings page. Edit form (name/slug/description/is_public + logo) is a
// labeled rework of the old profil/club/ManagePanel.jsx EditClubSection
// (lines 274-327); TransferOwnershipSection (329-397) and DeleteClubSection
// (400-446) are copied verbatim below (owner-only), with delete's reload()
// swapped for a navigate('/profil/klub') since a deleted club has nothing
// left to reload. That file is deleted in a later task, so this page owns
// its own copy rather than importing from it.

const primaryBtnClass = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all disabled:opacity-40 disabled:cursor-not-allowed'
const btnOk = `${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`
const btnGhost = `${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright`
const btnDanger = `${actionBtnClass} border-apex-red text-apex-red hover:bg-apex-red hover:text-apex-ink`

const fieldLabel = 'block font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1'
const fieldInput = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'

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
  const [slugValue, setSlugValue] = useState(club.slug)
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
      const trimmedSlug = slugValue.trim()
      if (trimmedSlug !== club.slug) payload.slug = trimmedSlug
      await updateClub(club.id, payload)
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
    <div className="space-y-8">
      <div>
        <div className={sectionTitle}>Edytuj klub</div>
        <div className="mb-4">
          <ClubLogoUpload clubId={club.id} currentUrl={club.logo_url} onUploaded={() => reload()} />
        </div>
        <form onSubmit={save} className="space-y-3 max-w-sm">
          <div>
            <label htmlFor="club-name" className={fieldLabel}>Nazwa klubu</label>
            <input id="club-name" data-testid="edit-club-name" type="text" value={name}
              onChange={(e) => setName(e.target.value)} maxLength={120}
              placeholder="np. Zatyrani Gratisownia" className={fieldInput} />
          </div>
          <div>
            <label htmlFor="club-slug" className={fieldLabel}>Adres publicznej strony</label>
            <div className="flex items-center gap-1">
              <span className="font-mono text-xs text-apex-muted shrink-0">leszy.run/klub/</span>
              <input id="club-slug" data-testid="edit-club-slug" type="text" value={slugValue}
                onChange={(e) => setSlugValue(e.target.value)} maxLength={80}
                placeholder="np. zatyrani-gratisownia" className={fieldInput} />
            </div>
            {slugValue !== club.slug && (
              <p className="font-sans text-[11px] text-apex-yellow mt-1">
                Zmiana adresu: stary adres będzie przekierowywał na nowy.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="club-description" className={fieldLabel}>Opis klubu</label>
            <textarea id="club-description" data-testid="edit-club-description" value={description}
              onChange={(e) => setDescription(e.target.value)} rows={3}
              placeholder="Napisz kilka zdań o klubie — kto biega, skąd jesteście, jak dołączyć…"
              className={`${fieldInput} resize-none`} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              data-testid="toggle-club-public"
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="accent-[#BBDD00]"
            />
            <span className="font-sans text-xs text-apex-text">Publiczna strona klubu widoczna dla wszystkich</span>
          </label>
          {saveError && <p className="text-apex-red font-sans text-xs">{saveError}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" data-testid="save-club" disabled={saving} className={primaryBtnClass}>
              {saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
            </button>
            {saved && <span className="font-mono text-xs text-apex-yellow">Zapisano</span>}
          </div>
        </form>
      </div>

      {isOwner && (
        <div>
          <div className={sectionTitle}>Przekaż własność</div>
          {club.pending_owner_id ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="flex-1 text-apex-text">
                Oczekuje na akceptację: <strong>{nominee ? displayNameFor(nominee) : 'nowy właściciel'}</strong>
              </span>
              <button data-testid="cancel-nomination" onClick={cancelNomination} disabled={transferBusy} className={btnDanger}>
                Anuluj nominację
              </button>
            </div>
          ) : candidates.length === 0 ? (
            <p className="font-sans text-xs text-apex-muted">Brak innych aktywnych członków do nominacji.</p>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className={`${inputClass} appearance-none cursor-pointer max-w-xs`}
              >
                <option value="">— wybierz członka —</option>
                {candidates.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{displayNameFor(m)}</option>
                ))}
              </select>
              <button data-testid={target ? `nominate-${target}` : 'nominate'} onClick={nominate} disabled={transferBusy || !target} className={btnOk}>
                Nominuj na właściciela
              </button>
            </div>
          )}
          {transferError && <p className="text-apex-red font-sans text-xs mt-1.5">{transferError}</p>}
        </div>
      )}

      {isOwner && (
        <div>
          <div className={sectionTitle}>Usuń klub</div>
          {!confirming ? (
            <button data-testid="delete-club-btn" onClick={() => setConfirming(true)} className={btnDanger}>
              Usuń klub
            </button>
          ) : (
            <div className="border border-apex-red p-3 max-w-sm">
              <p className="font-sans text-xs text-apex-text mb-2">
                Usunięcie klubu «{club.name}» jest nieodwracalne. Wszyscy członkowie stracą przypisanie do klubu.
              </p>
              <div className="flex items-center gap-2">
                <button data-testid="confirm-delete-club" onClick={doDelete} disabled={deleteBusy} className={btnDanger}>
                  {deleteBusy ? 'Usuwanie…' : 'Tak, usuń klub'}
                </button>
                <button onClick={() => setConfirming(false)} disabled={deleteBusy} className={btnGhost}>Anuluj</button>
              </div>
            </div>
          )}
          {deleteError && <p className="text-apex-red font-sans text-xs mt-1.5">{deleteError}</p>}
        </div>
      )}
    </div>
  )
}
