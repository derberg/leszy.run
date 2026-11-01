import { MAX_EXTRA_QTY, soldOut } from '../../lib/cartModel.js'
import { inputCls, labelCls } from './ui.js'

// RA2/RA3 (Plan 7, ruling 6): the extras one person orders, one row per extra with a variant
// select and a quantity 0–10. A sold-out variant stays in the list as „brak” and cannot be picked;
// an extra with nothing left shows „brak” and no controls. `extras` are cartModel's orderableExtras
// for the person's competition, `picks` the card's { [extraId]: { variantId, qty } }.

const QTYS = Array.from({ length: MAX_EXTRA_QTY + 1 }, (_, i) => i)

/**
 * @param {{ idPrefix: string, extras: object[], picks: Record<string, { variantId?: string, qty?: number }>,
 *   onPick: (extraId: string, patch: object) => void, error?: string, disabled?: boolean }} p
 */
export default function ExtrasPicker({ idPrefix, extras, picks, onPick, error, disabled = false }) {
  if (!extras?.length) return null
  const errorId = `${idPrefix}-extras-error`
  return (
    <div className="flex flex-col gap-2" data-testid="extras">
      <ul className="flex flex-col gap-2">
        {extras.map((x, i) => {
          const id = `${idPrefix}-extra-${i + 1}`
          const gone = soldOut(x)
          const firstLeft = x.variants.find((v) => !v.soldOut)
          const pick = picks?.[x.id] ?? {}
          const variantId = x.variants.some((v) => v.id === pick.variantId && !v.soldOut) ? pick.variantId : firstLeft?.id
          const qty = pick.qty ?? 0
          const invalid = !!error && qty > 0
          return (
            <li key={x.id} className="border border-apex-border bg-apex-surface px-3 py-2.5 flex flex-col gap-2" data-testid="extra">
              <div className="flex items-center gap-3">
                {x.imageUrl && <img src={x.imageUrl} alt="" className="w-12 h-12 object-cover shrink-0 border border-apex-border" />}
                <span id={`${id}-name`} className="min-w-0 flex-1 text-[17px] font-bold text-apex-text-bright [overflow-wrap:anywhere]">{x.name}</span>
                <span className="font-mono text-apex-yellow whitespace-nowrap">{x.priceLabel}</span>
              </div>
              {gone
                ? <span className="font-mono text-sm uppercase text-apex-muted" data-testid="extra-sold-out">brak</span>
                : (
                  <div className="grid grid-cols-[1fr_6rem] gap-2.5 items-end">
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <label htmlFor={`${id}-variant`} className={labelCls}>Wariant</label>
                      <select id={`${id}-variant`} className={inputCls} value={variantId ?? ''} disabled={disabled}
                        aria-describedby={`${id}-name`}
                        onChange={(e) => onPick(x.id, { variantId: e.target.value })}>
                        {x.variants.map((v) => (
                          <option key={v.id} value={v.id} disabled={v.soldOut}>{v.soldOut ? `${v.label} · brak` : v.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`${id}-qty`} className={labelCls}>Ilość</label>
                      <select id={`${id}-qty`} className={`${inputCls} font-mono ${invalid ? 'border-apex-red' : ''}`} value={qty} disabled={disabled}
                        data-testid="extra-qty" aria-invalid={invalid ? 'true' : undefined}
                        aria-describedby={invalid ? errorId : `${id}-name`}
                        onChange={(e) => onPick(x.id, { variantId, qty: Number(e.target.value) })}>
                        {QTYS.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                  </div>
                )}
            </li>
          )
        })}
      </ul>
      {error && <p id={errorId} className="text-apex-red font-sans text-sm">{error}</p>}
    </div>
  )
}
