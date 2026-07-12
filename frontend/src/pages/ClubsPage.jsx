import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export default function ClubsPage() {
  const queryClient = useQueryClient()
  const [merging, setMerging] = useState(null) // pair key while a merge is in flight

  const { data, isLoading } = useQuery({
    queryKey: ['clubs'],
    queryFn: async () => {
      const res = await fetch(`${API}/api/clubs`)
      if (!res.ok) throw new Error('Failed to load clubs')
      return res.json()
    },
  })

  const merge = useMutation({
    mutationFn: async ({ targetId, sourceIds }) => {
      const res = await fetch(`${API}/api/clubs/${targetId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceIds }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Merge failed')
      return body
    },
    onSettled: () => {
      setMerging(null)
      queryClient.invalidateQueries({ queryKey: ['clubs'] })
    },
  })

  if (isLoading) return <div className="p-8 font-mono text-sm text-apex-muted animate-pulse">Ładowanie…</div>

  const clubs = data?.data ?? []
  const duplicates = data?.duplicates ?? []
  const byId = Object.fromEntries(clubs.map(c => [c.id, c]))

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <h1 className="font-display font-extrabold text-2xl text-apex-text-bright uppercase tracking-wider mb-6">Kluby</h1>

      {duplicates.length > 0 && (
        <section className="mb-8">
          <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3">
            Możliwe duplikaty
          </h2>
          <div className="space-y-2">
            {duplicates.map(d => {
              const key = `${d.a_id}:${d.b_id}`
              const a = byId[d.a_id], b = byId[d.b_id]
              if (!a || !b) return null
              // keep the club with more members as the merge target
              const [target, source] = (a.memberCount >= b.memberCount) ? [a, b] : [b, a]
              return (
                <div key={key} className="flex items-center gap-3 border border-apex-border p-3 text-sm">
                  <span className="flex-1 text-apex-text">
                    <span className="text-apex-text-bright">{target.name}</span>
                    <span className="font-mono text-xs text-apex-muted ml-1.5">({target.memberCount})</span>
                    <span className="text-apex-muted mx-2">←</span>
                    {source.name}
                    <span className="font-mono text-xs text-apex-muted ml-1.5">({source.memberCount})</span>
                  </span>
                  <span className="font-mono text-[10px] text-apex-muted">sim {Math.round(d.sim * 100)}%</span>
                  <button
                    disabled={merging === key}
                    onClick={() => {
                      if (!confirm(`Połączyć "${source.name}" → "${target.name}"? Wszyscy członkowie zostaną przepisani.`)) return
                      setMerging(key)
                      merge.mutate({ targetId: target.id, sourceIds: [source.id] })
                    }}
                    className="font-mono text-xs text-apex-yellow border border-apex-yellow px-3 py-1 hover:bg-apex-yellow hover:text-black transition-all disabled:opacity-40"
                  >
                    {merging === key ? '…' : 'Połącz'}
                  </button>
                </div>
              )
            })}
          </div>
          {merge.isError && <p className="text-apex-red font-sans text-sm mt-2">{merge.error.message}</p>}
        </section>
      )}

      <section>
        <h2 className="font-display font-bold text-xs tracking-widest uppercase text-apex-muted border-b border-apex-border pb-1 mb-3">
          Wszystkie kluby ({clubs.length})
        </h2>
        {clubs.length === 0 ? (
          <p className="font-sans text-sm text-apex-muted py-4">Brak klubów — powstaną, gdy użytkownicy zaczną je wpisywać.</p>
        ) : (
          <div className="divide-y divide-apex-border/50">
            {clubs.map(c => (
              <div key={c.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1 text-apex-text">{c.name}</span>
                <span className="font-mono text-xs text-apex-muted">{c.memberCount} czł.</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
