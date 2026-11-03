import { infoCells } from '../lib/eventFacts.js'

/**
 * Adaptive 2-column info grid for event detail pages.
 * Only renders cells that have data. When odd number of cells,
 * last cell spans full width. The build script renders the same cells
 * (scripts/generate-event-pages.js), so keep the markup in step with it.
 *
 * @param {{ event: Object }} props
 */
export default function EventInfoGrid({ event }) {
  if (!event) return null

  const cells = infoCells(event)
  if (cells.length === 0) return null

  const isOdd = cells.length % 2 !== 0

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 border-t border-apex-border">
      {cells.map((cell, i) => {
        const isLast = i === cells.length - 1
        const spanFull = isLast && isOdd
        return (
          <div
            key={cell.label}
            className={`px-5 py-4 border-b border-apex-border ${spanFull ? 'md:col-span-2' : ''}`}
          >
            <div className="font-mono text-[10px] font-semibold tracking-[2px] uppercase text-apex-dim mb-1">
              {cell.label}
            </div>
            <div className={`font-sans text-base font-semibold ${cell.closed ? 'text-apex-red' : cell.accent ? 'text-apex-yellow' : 'text-apex-text-bright'}`}>
              {cell.value}
            </div>
          </div>
        )
      })}
    </div>
  )
}
