import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

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

export default function PartnerLogos({ eventId }) {
  const [partners, setPartners] = useState([])

  useEffect(() => {
    if (!eventId) return
    supabase
      .from('event_partners')
      .select('id, name, logo_url, website_url, sort_order')
      .eq('event_id', eventId)
      .order('sort_order')
      .then(({ data }) => setPartners(data || []))
  }, [eventId])

  if (partners.length === 0) return null

  const textOnly = partners.filter(p => !p.logo_url)
  const withLogos = partners.filter(p => p.logo_url)

  return (
    <div className="py-8 border-t border-apex-border">
      <div className="text-center mb-4">
        <span className="font-mono text-[10px] font-semibold tracking-[0.2em] uppercase text-apex-muted">
          Partnerzy
        </span>
      </div>

      {textOnly.length > 0 && (
        <div className="flex items-center justify-center gap-x-4 gap-y-1 flex-wrap mb-4">
          {textOnly.map(p => <PartnerLink key={p.id} partner={p} />)}
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
      )}
    </div>
  )
}
