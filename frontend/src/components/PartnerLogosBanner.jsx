import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.js'

export default function PartnerLogosBanner({ eventId }) {
  const { data: partners = [] } = useQuery({
    queryKey: ['partners', eventId],
    queryFn: () => api.partners.list(eventId),
    enabled: !!eventId,
  })

  const withLogos = partners.filter(p => p.logo_url)
  if (withLogos.length === 0) return null

  return (
    <div className="py-8 border-t border-apex-border">
      <div className="text-center mb-4">
        <span className="font-mono text-[10px] font-semibold tracking-[0.2em] uppercase text-apex-muted">
          Partnerzy
        </span>
      </div>
      <div className="flex items-center justify-center gap-8 flex-wrap">
        {withLogos.map(p => {
          const img = (
            <img
              key={p.id}
              src={p.logo_url}
              alt={p.name}
              title={p.name}
              className="max-h-12 max-w-[120px] object-contain opacity-80 hover:opacity-100 transition-opacity"
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
    </div>
  )
}
