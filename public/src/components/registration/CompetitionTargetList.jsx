import { useId } from 'react'
import { formatPln } from '@registration/money.js'

// The competitions an entry can move to, with each one's price and the difference, as a radio
// group: the club's „Zmień konkurencję” (B3, ChangeCompetitionDialog) and the runner's own
// (Moje zapisy, ChangeMyCompetitionDialog). Targets are change_competition_preview's /
// my-entry-action targets' rows: { categoryId, name, price, difference, kind, eligible, reason,
// voucherLost, extrasNotOffered }.

export const TARGET_REASON = {
  ineligible: 'nie spełnia warunków',
  role_change: 'inna grupa wiekowa',
  no_payer: 'brak płatnika',
  no_price: 'brak ceny',
  race_day: 'dzień zawodów',
  paying_closed: 'płatność zamknięta',
  full: 'brak miejsc',
  offline_paid: 'przez organizatora',
}

/** „bez zmiany ceny” / „zwrot 20,00 zł” / „dopłata 20,00 zł — zapłata online” */
export function differenceText(t) {
  if (t.kind === 'refund') return `zwrot ${formatPln(-t.difference)}`
  if (t.kind === 'surcharge') return `dopłata ${formatPln(t.difference)} — zapłata online`
  return 'bez zmiany ceny'
}

/** Skeleton rows while the targets load. */
export function TargetsLoading() {
  return <div className="flex flex-col gap-1.5" aria-busy="true">{[0, 1].map((i) => <div key={i} className="h-11 bg-apex-surface-2" />)}</div>
}

/**
 * @param {{ targets: object[], categoryId: string|null, onPick: (categoryId: string) => void, busy: boolean }} p
 */
export default function CompetitionTargetList({ targets, categoryId, onPick, busy }) {
  const ids = useId()
  const target = targets.find((t) => t.categoryId === categoryId) ?? null
  return (
    <>
      <div role="radiogroup" aria-label="Nowa konkurencja" data-testid="change-targets" className="flex flex-col gap-1.5">
        {targets.map((t) => (
          <label key={t.categoryId} data-testid="change-target"
            className={`flex items-center gap-2.5 min-h-11 px-3 py-1.5 border min-w-0 ${!t.eligible
              ? 'border-apex-border opacity-60 cursor-not-allowed' : t.categoryId === categoryId ? 'border-apex-yellow cursor-pointer' : 'border-apex-border-mid cursor-pointer'}`}>
            <input type="radio" name={`${ids}-target`} value={t.categoryId} checked={t.categoryId === categoryId} disabled={busy || !t.eligible}
              onChange={() => onPick(t.categoryId)} className="accent-apex-yellow w-4 h-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block font-sans font-semibold text-base text-apex-text-bright [overflow-wrap:anywhere]">{t.name}</span>
              <span className="block font-mono text-xs text-apex-muted [overflow-wrap:anywhere]">
                {formatPln(t.price)} · <span className={t.kind === 'surcharge' ? 'text-apex-cyan' : t.kind === 'refund' ? 'text-apex-yellow' : ''}>{differenceText(t)}</span>
              </span>
              {t.voucherLost && (
                <span className="block font-mono text-xs text-apex-red [overflow-wrap:anywhere]" data-testid="change-voucher-lost">
                  kod rabatowy nie obejmuje tej konkurencji
                </span>
              )}
            </span>
            {!t.eligible && (
              <span className="shrink-0 whitespace-nowrap font-mono text-xs uppercase text-apex-muted">{TARGET_REASON[t.reason] ?? 'niedostępna'}</span>
            )}
          </label>
        ))}
      </div>
      {target?.extrasNotOffered?.length > 0 && (
        <p className="font-sans text-sm text-apex-text [overflow-wrap:anywhere]" data-testid="change-extras">
          Dodatki niedostępne w tej konkurencji: {target.extrasNotOffered.join(', ')}
        </p>
      )}
    </>
  )
}
