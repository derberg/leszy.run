import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'

function SuggestionCard({ suggestion, onApprove, onReject }) {
  return (
    <div className="border border-apex-border bg-apex-surface p-4 mb-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-apex-yellow-dim mb-1">#{suggestion.rank}</div>
          <a href={suggestion.url} target="_blank" rel="noopener" className="text-apex-cyan text-sm hover:underline break-all">
            {suggestion.url}
          </a>
          {suggestion.page_title && (
            <div className="text-sm text-apex-text-bright mt-1 font-semibold">{suggestion.page_title}</div>
          )}
          {suggestion.snippet && (
            <div className="text-xs text-apex-muted mt-1 line-clamp-2">{suggestion.snippet}</div>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={() => onApprove(suggestion.id)}
            className="px-4 py-2 bg-apex-yellow text-apex-bg font-display font-bold text-xs tracking-wider uppercase hover:shadow-[0_0_12px_rgba(187,221,0,0.3)]">
            Zatwierdz
          </button>
          <button onClick={() => onReject(suggestion.id)}
            className="px-4 py-2 border border-apex-red text-apex-red font-display font-bold text-xs tracking-wider uppercase hover:bg-apex-red hover:text-white">
            Odrzuc
          </button>
        </div>
      </div>
    </div>
  )
}

export default function UrlReview() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['url-suggestions'],
    queryFn: () => api.get('/url-suggestions?status=pending').then(r => r.data),
  })

  const approveMutation = useMutation({
    mutationFn: (id) => api.post(`/url-suggestions/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['url-suggestions'] }),
  })

  const rejectMutation = useMutation({
    mutationFn: (id) => api.post(`/url-suggestions/${id}/reject`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['url-suggestions'] }),
  })

  const grouped = (data || []).reduce((acc, s) => {
    const eventId = s.calendar_events?.id || s.calendar_event_id
    if (!acc[eventId]) {
      acc[eventId] = {
        event: s.calendar_events || { name: 'Unknown', date: '', location: '' },
        suggestions: [],
      }
    }
    acc[eventId].suggestions.push(s)
    return acc
  }, {})

  return (
    <div className="p-6">
      <h1 className="font-display text-3xl font-extrabold tracking-wider uppercase text-apex-text-bright mb-2">
        Weryfikacja linkow
      </h1>
      <p className="text-apex-muted text-sm mb-8">
        Zatwierdz lub odrzuc sugerowane linki do zapisow dla wydarzen bez URL.
      </p>

      {isLoading && <div className="text-apex-muted">Ladowanie...</div>}

      {Object.entries(grouped).map(([eventId, { event, suggestions }]) => (
        <div key={eventId} className="mb-8">
          <div className="mb-3">
            <div className="font-display font-bold text-lg tracking-wide uppercase text-apex-text-bright">{event.name}</div>
            <div className="text-xs text-apex-muted">{event.date} &middot; {event.location}</div>
          </div>
          {suggestions.sort((a, b) => a.rank - b.rank).map(s => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onApprove={(id) => approveMutation.mutate(id)}
              onReject={(id) => rejectMutation.mutate(id)}
            />
          ))}
        </div>
      ))}

      {!isLoading && Object.keys(grouped).length === 0 && (
        <div className="text-apex-muted text-center py-12">Brak oczekujacych sugestii.</div>
      )}
    </div>
  )
}
