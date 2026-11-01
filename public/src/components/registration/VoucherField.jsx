import { editBtn, inputCls, labelCls } from './ui.js'

// RA2/RA3 (Plan 7): one discount code per person. „Sprawdź” asks check-voucher (the parent's
// `onCheck`); an accepted code shows RA4's line („60,00 zł − 15% (KOD) = 51,00 zł”), a refused one
// its copy under the field, linked to it. `note`: check-voucher could not judge the code (429, no
// connection); the form still goes on and create-order decides. Enter in the field checks the code
// instead of submitting the form.

/**
 * @param {{ id: string, value: { code: string, state: string }, okLabel?: string|null, error?: string, note?: string|null,
 *   onCode: (code: string) => void, onCheck: () => void, disabled?: boolean }} p
 */
export default function VoucherField({ id, value, okLabel = null, error, note = null, onCode, onCheck, disabled = false }) {
  const checking = value.state === 'checking'
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-1.5" data-testid="voucher">
      <label htmlFor={id} className={labelCls}>Kod rabatowy</label>
      <div className="flex gap-2">
        <input id={id} className={`${inputCls} min-w-0 flex-1 font-mono uppercase ${error ? 'border-apex-red' : ''}`}
          value={value.code} maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false}
          aria-invalid={error ? 'true' : undefined} aria-describedby={error ? errorId : undefined} disabled={disabled}
          onChange={(e) => onCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (value.code.trim() && !checking) onCheck() } }} />
        <button type="button" className={`${editBtn} shrink-0`} onClick={onCheck} disabled={disabled || checking || !value.code.trim()}>
          Sprawdź
        </button>
      </div>
      {value.state === 'ok' && okLabel && (
        <p className="font-mono text-sm text-apex-yellow" data-testid="voucher-ok" role="status">{okLabel}</p>
      )}
      {!error && note && <p className="font-sans text-sm text-apex-muted" data-testid="voucher-note" role="status">{note}</p>}
      {error && <p id={errorId} className="text-apex-red font-sans text-sm">{error}</p>}
    </div>
  )
}
