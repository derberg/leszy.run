import { useId } from 'react'
import { PUBLIC_CLUB_PAGE_SHIPPED } from '../lib/clubPage.js'

// Membership visibility radio — maps to club_members.hidden_public.
// value=false → member appears on the public club page; value=true → visible
// to clubmates only. Editable later on /klub/:slug/panel and in Ustawienia.
// <MembershipVisibilityChoice value={hidden} onChange={(hidden) => {}} />
export default function MembershipVisibilityChoice({ value, onChange }) {
  const uid = useId()
  // Hidden with the page it governs. The public club page is not shipped (see
  // public/public/klub/.manifest.json), so this choice decides nothing today.
  // It used to be shown disabled with a "wkrótce" note, which only asked people
  // a question they could not answer. Every new membership is stored as
  // clubmates-only (hidden_public = true) instead, and people choose for
  // themselves once the page exists. Flip PUBLIC_CLUB_PAGE_SHIPPED to bring it back.
  if (!PUBLIC_CLUB_PAGE_SHIPPED) return null
  const optionClass = 'flex items-center gap-2 font-sans text-xs text-apex-text cursor-not-allowed'
  return (
    <fieldset data-testid="visibility-choice" disabled className="space-y-1.5 opacity-50">
      <legend className="font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1">
        Widoczność w klubie
      </legend>
      <label className={optionClass}>
        <input type="radio" name={`membership-visibility-${uid}`} checked={!value}
          onChange={() => onChange(false)} className="accent-[#BBDD00]" />
        <span>Publiczna — widać mnie na publicznej stronie klubu</span>
      </label>
      <label className={optionClass}>
        <input type="radio" name={`membership-visibility-${uid}`} checked={!!value}
          onChange={() => onChange(true)} className="accent-[#BBDD00]" />
        <span>Tylko dla klubowiczów</span>
      </label>
      <p className="font-sans text-[10px] text-apex-muted">
        Wkrótce — publiczna strona klubu jest w przygotowaniu.
      </p>
    </fieldset>
  )
}
