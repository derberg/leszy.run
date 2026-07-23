import { useId } from 'react'

// Membership visibility radio — maps to club_members.hidden_public.
// value=false → member appears on the public club page; value=true → visible
// to clubmates only. Editable later on /klub/:slug/panel and in Ustawienia.
// <MembershipVisibilityChoice value={hidden} onChange={(hidden) => {}} />
export default function MembershipVisibilityChoice({ value, onChange }) {
  const uid = useId()
  const optionClass = 'flex items-center gap-2 cursor-pointer font-sans text-xs text-apex-text'
  return (
    <fieldset data-testid="visibility-choice" className="space-y-1.5">
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
    </fieldset>
  )
}
