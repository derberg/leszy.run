import { useState } from 'react'
import { useProfil } from '../context.js'
import { transferOwnership, acceptInvite } from '../../../lib/clubs.js'
import { actionBtnClass } from '../fields.jsx'
import MembershipVisibilityChoice from '../../../components/MembershipVisibilityChoice.jsx'

// Nominee / pending-join / direct-invite prompts, rendered at the top of
// Klub.jsx regardless of which club branch (no-club / member / manage) is
// showing — a nominee or invitee may already be a member of a different club,
// or of none at all. Data comes from get-profile-data via ProfilContext
// (pending_membership / pending_ownership / incoming_invites), which the
// backend now returns (see supabase/functions/get-profile-data/index.js).

const bannerClass = 'border border-apex-yellow-dim px-3.5 py-3 mb-3'
const btnPrimary = `${actionBtnClass} border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink`
const btnGhost = `${actionBtnClass} border-apex-border text-apex-muted hover:text-apex-text-bright`

function OwnershipPrompt({ club, onDone }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function act(op) {
    setBusy(true)
    setError(null)
    try {
      await transferOwnership(club.id, op)
      await onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={bannerClass} data-testid="prompt-ownership">
      <p className="font-display font-bold text-xs tracking-widest uppercase text-apex-yellow mb-1">
        Zostań właścicielem klubu «{club.name}»?
      </p>
      <p className="font-sans text-xs text-apex-muted mb-2">
        Dotychczasowy właściciel nominował Cię na nowego właściciela tego klubu.
      </p>
      <div className="flex items-center gap-2">
        <button data-testid="accept-ownership" onClick={() => act('accept')} disabled={busy} className={btnPrimary}>
          Przejmij klub
        </button>
        <button data-testid="decline-ownership" onClick={() => act('decline')} disabled={busy} className={btnGhost}>
          Odrzuć
        </button>
      </div>
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}

function PendingMembershipPrompt({ membership }) {
  return (
    <div className={bannerClass} data-testid="prompt-pending-membership">
      <p className="font-sans text-sm text-apex-text">
        Twoja prośba o dołączenie do «{membership.club_name}» oczekuje na akceptację.
      </p>
    </div>
  )
}

function InvitePrompt({ invite, onDone }) {
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState(null)
  const [hiddenPublic, setHiddenPublic] = useState(false)

  async function accept() {
    setBusy(true)
    setError(null)
    try {
      await acceptInvite({ invite_id: invite.id, hidden_public: hiddenPublic })
      await onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (dismissed) return null

  return (
    <div className={bannerClass} data-testid="prompt-invite">
      <p className="font-display font-bold text-xs tracking-widest uppercase text-apex-yellow mb-1">
        Masz zaproszenie do klubu «{invite.club_name}»
      </p>
      <MembershipVisibilityChoice value={hiddenPublic} onChange={setHiddenPublic} />
      <div className="flex items-center gap-2 mt-2">
        <button data-testid="accept-invite-btn" onClick={accept} disabled={busy} className={btnPrimary}>
          Dołącz
        </button>
        <button onClick={() => setDismissed(true)} className={btnGhost}>Odrzuć</button>
      </div>
      {error && <p className="text-apex-red font-sans text-xs mt-1.5">{error}</p>}
    </div>
  )
}

// <ClubPrompts reloadClub={() => {}} /> — reloadClub is useClub()'s reload,
// so accepting a nomination/invite (which changes the caller's active club)
// refreshes the club section below the prompts too, not just the prompt list.
export default function ClubPrompts({ reloadClub }) {
  const { pendingMembership, pendingOwnership, incomingInvites, refreshProfileData } = useProfil()

  async function onActed() {
    await refreshProfileData()
    await reloadClub?.()
  }

  const hasAny = pendingMembership || (pendingOwnership?.length > 0) || (incomingInvites?.length > 0)
  if (!hasAny) return null

  return (
    <div data-testid="club-prompts">
      {pendingOwnership.map((club) => (
        <OwnershipPrompt key={club.id} club={club} onDone={onActed} />
      ))}
      {pendingMembership && <PendingMembershipPrompt membership={pendingMembership} />}
      {incomingInvites.map((invite) => (
        <InvitePrompt key={invite.id} invite={invite} onDone={onActed} />
      ))}
    </div>
  )
}
