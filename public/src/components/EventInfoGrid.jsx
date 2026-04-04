/**
 * Adaptive 2-column info grid for event detail pages.
 * Only renders cells that have data. When odd number of cells,
 * last cell spans full width.
 *
 * @param {{ event: Object }} props
 */
export default function EventInfoGrid({ event }) {
  if (!event) return null

  const cells = []

  // Data
  if (event.date) {
    const start = new Date(event.date).toLocaleDateString('pl-PL', {
      day: 'numeric', month: 'long', year: 'numeric',
    })
    cells.push({ label: 'Data', value: start })
  }

  // Lokalizacja
  if (event.location || event.voivodeship) {
    const parts = [event.location, event.voivodeship].filter(Boolean)
    cells.push({ label: 'Lokalizacja', value: parts.join(', ') })
  }

  // Dystanse
  if (event.distances?.length) {
    cells.push({ label: 'Dystanse', value: event.distances.join(' / ') })
  }

  // Cena
  if (event.price_from != null || event.price_to != null) {
    let value = ''
    if (event.price_from != null && event.price_to != null) {
      value = `od ${event.price_from} zł do ${event.price_to} zł`
    } else if (event.price_from != null) {
      value = `od ${event.price_from} zł`
    } else {
      value = `do ${event.price_to} zł`
    }
    cells.push({ label: 'Cena', value, accent: true })
  }

  // Termin zapisów
  if (event.registration_deadline) {
    const deadlineDate = new Date(event.registration_deadline + 'T23:59:59')
    const isPast = deadlineDate < new Date()
    const formatted = new Date(event.registration_deadline).toLocaleDateString('pl-PL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    })
    cells.push({
      label: 'Termin zapisów',
      value: isPast ? `Zapisy zamknięte (${formatted})` : `do ${formatted}`,
      accent: true,
      closed: isPast,
    })
  }

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
