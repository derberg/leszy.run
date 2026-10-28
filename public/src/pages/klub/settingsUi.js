import { primaryBtnClass } from '../profil/fields.jsx'

// Shared presentation for the club settings page and its payout section: one
// flat panel per section, a real heading, readable labels, one button style.

export const panelClass = 'border border-apex-border-mid bg-apex-surface p-5 sm:p-6'
export const dangerPanelClass = 'border border-apex-red bg-apex-surface p-5 sm:p-6'
export const panelTitle = 'font-display font-extrabold text-[22px] sm:text-2xl leading-none tracking-wide uppercase text-apex-text-bright mb-5'
export const dangerPanelTitle = 'font-display font-extrabold text-[22px] sm:text-2xl leading-none tracking-wide uppercase text-apex-red mb-5'

export const formWidth = 'max-w-[640px]'
export const fieldLabel = 'block font-display font-bold text-[13px] tracking-wider uppercase text-apex-muted mb-1.5'
export const fieldInput = 'w-full min-w-0 bg-apex-bg border border-apex-border-mid text-apex-text-bright font-sans text-base font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
export const hintClass = 'font-sans text-sm text-apex-muted mt-1.5'
export const errorClass = 'text-apex-red font-sans text-sm'
export const savedClass = 'font-mono text-sm text-apex-yellow'

// Same shape as the club area's primary button; the variants only change colour.
const btnBase = 'whitespace-nowrap font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 border-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed'
export const btnPrimary = primaryBtnClass
export const btnDanger = `${btnBase} border-apex-red text-apex-red hover:bg-apex-red hover:text-white disabled:hover:bg-transparent disabled:hover:text-apex-red`
export const btnGhost = `${btnBase} border-apex-border-bright text-apex-muted hover:text-apex-text-bright hover:border-apex-text`
