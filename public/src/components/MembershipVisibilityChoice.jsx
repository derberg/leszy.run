import { useId } from 'react'

// Membership visibility radio — maps to club_members.hidden_public.
// value=false → member appears on the public club page; value=true → visible
// to clubmates only. Editable later on /klub/:slug/panel and in Ustawienia.
// <MembershipVisibilityChoice value={hidden} onChange={(hidden) => {}} />
export default function MembershipVisibilityChoice({ value, onChange }) {
  const uid = useId()
  // Parked with the page it governs. The public club page is not shipped (see
  // public/public/klub/.manifest.json), so this choice decides nothing today —
  // but it is left visible and disabled rather than removed, because it comes
  // back with the page, and a control that vanishes reads as a feature that was
  // dropped. The stored hidden_public value is untouched.
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
