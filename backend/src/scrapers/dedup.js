import { supabase } from '../lib/supabaseClient.js'

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

function nameSimilarity(a, b) {
  const normA = a.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').trim()
  const normB = b.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/g, '').trim()
  const maxLen = Math.max(normA.length, normB.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(normA, normB) / maxLen
}

async function findExistingMatch(event) {
  if (!supabase) return null

  if (event.source_id) {
    const { data } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('source', event.source)
      .eq('source_id', event.source_id)
      .single()

    if (data) return data
  }

  const { data: candidates } = await supabase
    .from('calendar_events')
    .select('*')
    .eq('date', event.date)

  if (candidates) {
    for (const candidate of candidates) {
      if (nameSimilarity(candidate.name, event.name) > 0.8) {
        return candidate
      }
    }
  }

  return null
}

async function upsertEvent(event) {
  if (!supabase) return { action: 'skipped', id: null, error: { message: 'Supabase not configured' } }

  const existing = await findExistingMatch(event)

  if (existing) {
    // Never resurrect rejected events
    if (existing.status === 'rejected') {
      return { action: 'skipped', id: existing.id, error: null }
    }

    // Only fill in fields that are missing on the existing event — never overwrite
    const updates = {}
    const protectedKeys = ['id', 'created_at', 'status']
    for (const [key, value] of Object.entries(event)) {
      if (protectedKeys.includes(key)) continue
      if (value === null || value === undefined) continue
      if (Array.isArray(value) && value.length === 0) continue

      const existingVal = existing[key]
      const isEmpty = existingVal === null || existingVal === undefined ||
        (Array.isArray(existingVal) && existingVal.length === 0) ||
        existingVal === ''
      if (isEmpty) {
        updates[key] = value
      }
    }
    updates.last_verified_at = new Date().toISOString()
    if (Object.keys(updates).length === 1) {
      // Only last_verified_at — nothing to fill in
      updates.updated_at = new Date().toISOString()
    }

    const { error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', existing.id)

    return { action: 'updated', id: existing.id, error }
  } else {
    const { data, error } = await supabase
      .from('calendar_events')
      .insert(event)
      .select('id')
      .single()

    return { action: 'created', id: data?.id, error }
  }
}

export { findExistingMatch, upsertEvent, nameSimilarity }
