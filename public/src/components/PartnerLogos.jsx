/**
 * Renders an event's public partners. Pure: the caller passes the camelCase
 * list from the cached /api/event or /api/results JSON (or the organizer's
 * preview), so a viewer never queries Supabase.
 *
 * `variant`: 'light' (default) is the white box the results page has always
 * shown. 'dark' sits on the OVERDRIVE theme of the registration page: the
 * page's surface and border, a muted mono label, names in the page's text
 * colours and each logo on a small white tile, because logos are drawn for a
 * light background and many vanish on a dark one.
 * @param {{ partners?: Array<{ id: string, name: string, logoUrl: string|null, websiteUrl: string|null }>, variant?: 'light'|'dark' }} props
 */
export default function PartnerLogos({ partners = [], variant = 'light' }) {
  if (partners.length === 0) return null
  const dark = variant === 'dark'

  const textOnly = partners.filter(p => !p.logoUrl)
  const withLogos = partners.filter(p => p.logoUrl)
  const link = (p, child, className) => (p.websiteUrl
    ? <a key={p.id} href={p.websiteUrl} target="_blank" rel="noopener noreferrer sponsored" className={className}>{child}</a>
    : <span key={p.id} className={className}>{child}</span>)

  const box = dark
    ? 'border border-apex-border bg-apex-surface px-3.5 py-3'
    : 'bg-white rounded-sm px-8 py-4'
  const label = dark
    ? 'font-mono text-xs tracking-wider uppercase text-apex-muted'
    : 'font-mono text-[10px] font-semibold tracking-[0.2em] uppercase text-neutral-500'
  const name = dark
    ? 'font-sans text-base font-semibold text-apex-text-bright'
    : 'text-sm font-semibold text-neutral-500'
  const nameLink = dark ? `${name} hover:text-apex-yellow transition-colors` : `${name} hover:text-neutral-800 transition-colors`

  return (
    <div className={dark ? '' : 'pb-6'} data-testid="partner-logos">
      <div className={box}>
        <div className={dark ? 'mb-2.5' : 'text-center mb-3'}>
          <span className={label}>Partnerzy</span>
        </div>

        {textOnly.length > 0 && (
          <div className={`flex items-center gap-x-5 gap-y-1.5 flex-wrap ${dark ? '' : 'justify-center'} ${withLogos.length ? 'mb-3' : ''}`}>
            {textOnly.map(p => link(p, p.name, p.websiteUrl ? nameLink : name))}
          </div>
        )}

        {withLogos.length > 0 && (
          <div className={`flex items-center flex-wrap ${dark ? 'gap-2.5' : 'justify-center gap-8'}`}>
            {withLogos.map(p => {
              const img = (
                <img src={p.logoUrl} alt={p.name} loading="lazy" title={p.name}
                  className={dark ? 'max-h-12 max-w-[120px] object-contain' : 'max-h-16 max-w-[160px] object-contain'} />
              )
              if (!dark) return link(p, img, undefined)
              return link(p, img, 'flex items-center justify-center h-16 min-w-[96px] bg-white border border-apex-border px-3 py-2 hover:border-apex-yellow-dim transition-colors')
            })}
          </div>
        )}
      </div>
    </div>
  )
}
