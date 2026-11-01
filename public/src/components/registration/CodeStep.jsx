import { inputCls, labelCls, primaryBtn } from './ui.js'

// The e-mail code, as RA2 and RB1 ask for it. `submitLabel` is 'Dalej' where the code only opens
// the session, the action's own name where it also registers.

export default function CodeStep({ email, code, onCode, error, busy, onSubmit, onResend, onChangeAddress, resent, submitLabel }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" data-testid="code-step">
      <h1 className="font-display font-extrabold text-[38px] leading-none uppercase text-apex-text-bright">Sprawdź skrzynkę</h1>
      <p className="text-lg leading-snug">
        Wysłaliśmy 6-cyfrowy kod na <strong className="text-apex-text-bright break-all">{email}</strong>. Bez niego zgłoszenie nie powstanie.
      </p>
      <p className="text-sm text-apex-text border-l-2 border-apex-yellow pl-3">
        Nie widzisz maila? Zajrzyj do spamu i zakładek typu Oferty, Promocje czy Newslettery.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reg-code" className={labelCls}>Kod (6 cyfr)</label>
        <input id="reg-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required autoFocus
          value={code} onChange={(e) => onCode(e.target.value.replace(/\D/g, ''))}
          className={`${inputCls} font-mono text-2xl tracking-[0.5em] h-14 ${error ? 'border-apex-red' : ''}`} />
        {error && <p className="text-apex-red text-sm" data-testid="code-error" role="alert">{error}</p>}
      </div>
      <button type="submit" disabled={busy || code.length !== 6} className={primaryBtn}>
        {busy ? (submitLabel === 'Dalej' ? 'Sprawdzamy…' : 'Zapisujemy…') : submitLabel}
      </button>
      <div className="flex justify-between gap-3">
        <button type="button" onClick={onResend} disabled={busy} className="min-h-11 text-base text-apex-yellow whitespace-nowrap disabled:opacity-40">
          {resent ? 'Wysłano ponownie' : 'Wyślij ponownie'}
        </button>
        <button type="button" onClick={onChangeAddress} disabled={busy} className="min-h-11 text-base text-apex-muted whitespace-nowrap">Zmień adres</button>
      </div>
      <div className="border border-apex-border bg-apex-surface p-3.5 flex flex-col gap-1.5">
        <span className={labelCls}>Dlaczego kod?</span>
        <span className="text-base leading-snug">
          Sprawdzamy, że adres jest Twój — tu przyjdzie potwierdzenie zapisu i wiadomości od organizatora. Kod loguje Cię też do LESZY.RUN; konto powstaje samo.
        </span>
      </div>
    </form>
  )
}
