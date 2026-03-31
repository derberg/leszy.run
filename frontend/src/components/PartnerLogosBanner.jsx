import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.js'

function PartnerLink({ partner }) {
  const { name, website_url } = partner
  if (website_url) {
    return (
      <a href={website_url} target="_blank" rel="noopener noreferrer"
        className="text-xs font-semibold text-apex-muted hover:text-apex-yellow transition-colors">
        {name}
      </a>
    )
  }
  return <span className="text-xs font-semibold text-apex-muted">{name}</span>
}

export default function PartnerLogosBanner({ eventId }) {
  const { data: partners = [] } = useQuery({
    queryKey: ['partners', eventId],
    queryFn: () => api.partners.list(eventId),
    enabled: !!eventId,
  })

  if (partners.length === 0) return null

  const textOnly = partners.filter(p => !p.logo_url)
  const withLogos = partners.filter(p => p.logo_url)

  return (
    <div className="py-4">
      <div className="bg-white rounded-sm px-8 py-4">
        <div className="text-center mb-3">
          <span className="font-mono text-[10px] font-semibold tracking-[0.2em] uppercase text-neutral-400">
            Partnerzy
          </span>
        </div>

        {textOnly.length > 0 && (
          <div className="flex items-center justify-center gap-x-5 gap-y-1.5 flex-wrap mb-3">
            {textOnly.map(p => {
              if (p.website_url) {
                return (
                  <a key={p.id} href={p.website_url} target="_blank" rel="noopener noreferrer"
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
                  src={p.logo_url}
                  alt={p.name}
                  title={p.name}
                  className="max-h-16 max-w-[160px] object-contain"
                />
              )
              return p.website_url ? (
                <a key={p.id} href={p.website_url} target="_blank" rel="noopener noreferrer">
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
