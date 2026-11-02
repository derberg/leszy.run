import { DONATION_CHIPS } from '../../lib/cartModel.js'
import { inputCls, labelCls } from './ui.js'

// RA4 (Plan 7, ruling 7): „Dodatkowa darowizna na cel: <cel>” on a charity event with donations on, as
// chips „0”, „+5 zł”, „+10 zł”, „inna”. Under them: the chip is on top of the entry fee and reaches the
// organizer whole (umowa organizatora §7.1: „Organizator otrzymuje te kwoty w całości”), and, when
// the organizer stated it, what share of the event's income goes to the cause (`percent`).
// „0” is the starting choice: nothing that costs money is preselected. „inna” opens an amount in złote (1–5 000 zł, cartModel's parseDonationInput),
// whose error sits under it and is linked to it.

/**
 * @param {{ goal: string|null, percent?: number|null, chip: string, other: string, error?: string|null,
 *   onChip: (key: string) => void, onOther: (text: string) => void, disabled?: boolean }} p
 */
export default function DonationChips({ goal, percent = null, chip, other, error, onChip, onOther, disabled = false }) {
  const errorId = 'donation-error'
  return (
    <section className="flex flex-col gap-2" data-testid="donation" aria-labelledby="donation-heading">
      <h2 id="donation-heading" className="font-sans font-bold text-[17px] text-apex-text-bright [overflow-wrap:anywhere]">
        Dodatkowa darowizna na cel{goal ? `: ${goal}` : ''}
      </h2>
      <p className="text-[15px] text-apex-text" data-testid="donation-info">
        {percent != null && <><span className="font-mono">{percent}%</span> dochodu z zawodów trafia na ten cel. </>}
        Darowizna to dodatkowa kwota ponad opłatę startową. Przekazujemy ją organizatorowi w całości, na ten cel.
      </p>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-labelledby="donation-heading">
        {DONATION_CHIPS.map((c) => {
          const on = chip === c.key
          return (
            <button key={c.key} type="button" role="radio" aria-checked={on} disabled={disabled}
              onClick={() => onChip(c.key)}
              className={`min-h-11 px-1 border font-mono text-base whitespace-nowrap ${on
                ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-mid text-apex-text bg-apex-surface hover:border-apex-yellow-dim'}`}>
              {c.label}
            </button>
          )
        })}
      </div>
      {chip === 'other' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="donation-other" className={labelCls}>Kwota darowizny (zł)</label>
          <input id="donation-other" className={`${inputCls} font-mono ${error ? 'border-apex-red' : ''}`} inputMode="decimal"
            autoComplete="off" value={other} disabled={disabled} maxLength={12}
            aria-invalid={error ? 'true' : undefined} aria-describedby={error ? errorId : undefined}
            onChange={(e) => onOther(e.target.value)} />
        </div>
      )}
      {error && <p id={errorId} className="text-apex-red font-sans text-sm" role={chip === 'other' ? undefined : 'alert'}>{error}</p>}
    </section>
  )
}
