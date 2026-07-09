import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import useAuth from '../hooks/useAuth.js'
import useFavorites from '../hooks/useFavorites.js'
import useBeta from '../hooks/useBeta.js'

function StarIcon({ filled }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function FirstStarModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        data-testid="first-star-modal"
        className="bg-apex-bg border border-apex-yellow max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display font-bold text-sm tracking-widest uppercase text-apex-yellow mb-3">
          Obserwujesz ten bieg
        </h3>
        <p className="font-sans text-sm text-apex-text mb-3">
          Dostaniesz powiadomienie (w profilu), gdy:
        </p>
        <ul className="font-sans text-sm text-apex-text list-disc pl-5 space-y-1 mb-4">
          <li>bieg zostanie odwołany,</li>
          <li>pojawi się link do zapisów,</li>
          <li>zostanie 7 dni do końca zapisów.</li>
        </ul>
        <p className="font-sans text-xs text-apex-muted mb-4">
          Chcesz też cotygodniowe podsumowanie e-mailem? Włącz je w{' '}
          <a href="/profil" className="text-apex-yellow underline">swoim profilu</a>.
          Członkowie Twojego klubu widzą, które biegi obserwujesz — możesz to wyłączyć
          w ustawieniach prywatności w profilu.
        </p>
        <button
          onClick={onClose}
          className="font-display font-bold text-[11px] tracking-widest uppercase px-5 py-2 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all"
        >
          Rozumiem
        </button>
      </div>
    </div>
  )
}

export default function StarButton({ eventId, className = '' }) {
  const beta = useBeta()
  const { user } = useAuth()
  const { ready, isStarred, toggle } = useFavorites()
  const navigate = useNavigate()
  const location = useLocation()
  const [showFirstStar, setShowFirstStar] = useState(false)

  const starred = isStarred(eventId)

  // Dark-launched — no star UI until the accounts feature is live.
  if (!beta) return null

  const handleClick = async (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!user) {
      navigate(`/login?from=${encodeURIComponent(location.pathname + location.search)}`)
      return
    }
    if (!ready) return
    const wasFirst = await toggle(eventId)
    if (wasFirst) setShowFirstStar(true)
  }

  return (
    <>
      <button
        data-testid="star-event-btn"
        onClick={handleClick}
        title={starred ? 'Przestań obserwować' : 'Obserwuj ten bieg'}
        aria-label={starred ? 'Przestań obserwować' : 'Obserwuj ten bieg'}
        aria-pressed={starred}
        className={`px-2 py-1 border transition-colors shrink-0 ${
          starred
            ? 'border-apex-yellow text-apex-yellow'
            : 'border-apex-border text-apex-muted hover:text-apex-yellow hover:border-apex-yellow/40'
        } ${className}`}
      >
        <StarIcon filled={starred} />
      </button>
      {showFirstStar && <FirstStarModal onClose={() => setShowFirstStar(false)} />}
    </>
  )
}
