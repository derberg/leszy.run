/**
 * Renders an event's public partners. Pure: the caller passes the camelCase
 * list from the cached /api/event or /api/results JSON, so a viewer never
 * queries Supabase.
 * @param {{ partners?: Array<{ id: string, name: string, logoUrl: string|null, websiteUrl: string|null }> }} props
 */
export default function PartnerLogos({ partners = [] }) {
  if (partners.length === 0) return null

  const textOnly = partners.filter(p => !p.logoUrl)
  const withLogos = partners.filter(p => p.logoUrl)

  return (
    <div className="pb-6">
      <div className="bg-white rounded-sm px-8 py-4">
        <div className="text-center mb-3">
          <span className="font-mono text-[10px] font-semibold tracking-[0.2em] uppercase text-neutral-400">
            Partnerzy
          </span>
        </div>

        {textOnly.length > 0 && (
          <div className="flex items-center justify-center gap-x-5 gap-y-1.5 flex-wrap mb-3">
            {textOnly.map(p => {
              if (p.websiteUrl) {
                return (
                  <a key={p.id} href={p.websiteUrl} target="_blank" rel="noopener noreferrer sponsored"
                    className="text-sm font-semibold text-neutral-500 hover:text-neutral-800 transition-colors">
                    {p.name}
                  </a>
                )
              }
              return <span key={p.id} className="text-sm font-semibold text-neutral-500">{p.name}</span>
            })}
          </div>
        )}

        {withLogos.length > 0 && (
          <div className="flex items-center justify-center gap-8 flex-wrap">
            {withLogos.map(p => {
              const img = (
                <img
                  key={p.id}
                  src={p.logoUrl}
                  alt={p.name}
                  loading="lazy"
                  title={p.name}
                  className="max-h-16 max-w-[160px] object-contain"
                />
              )
              return p.websiteUrl ? (
                <a key={p.id} href={p.websiteUrl} target="_blank" rel="noopener noreferrer sponsored">
                  {img}
                </a>
              ) : (
                img
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
