import { createClient } from '@supabase/supabase-js'
import { eq } from 'drizzle-orm'
import { checkins, checkinDocuments } from '../db/schema.js'

let supabase = null
let lastSyncTime = null

export function initCheckinSync(db) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('[CheckinSync] Supabase credentials not set — reverse sync disabled')
    return
  }
  supabase = createClient(url, key)
  console.log('[CheckinSync] Reverse sync enabled, polling every 30s')
  setInterval(() => pullCheckins(db), 30_000)
  setTimeout(() => pullCheckins(db), 6_000)
}

export async function pullCheckins(db) {
  if (!supabase) return
  try {
    let query = supabase.from('checkins').select('*')
    if (lastSyncTime) query = query.gt('updated_at', lastSyncTime)
    const { data: remoteCheckins, error: checkinsError } = await query
    if (checkinsError) { console.error('[CheckinSync] Error fetching checkins:', checkinsError.message); return }
    if (!remoteCheckins?.length) return

    const now = new Date()
    for (const row of remoteCheckins) {
      const values = {
        id: row.id, participantId: row.participant_id, eventId: row.event_id,
        checkedInAt: row.checked_in_at ? new Date(row.checked_in_at) : null,
        createdAt: row.created_at ? new Date(row.created_at) : null,
        updatedAt: row.updated_at ? new Date(row.updated_at) : null, syncedAt: now,
      }
      try {
        await db.insert(checkins).values(values).onConflictDoUpdate({
          target: checkins.id,
          set: { checkedInAt: values.checkedInAt, updatedAt: values.updatedAt, syncedAt: now },
        })
      } catch (e) {
        if (e.code === '23505') {
          // Local row has same participant_id but different id — replace with Supabase's version
          await db.delete(checkins).where(eq(checkins.participantId, row.participant_id))
          await db.insert(checkins).values(values)
        } else throw e
      }
    }

    const checkinIds = remoteCheckins.map(c => c.id)
    const { data: remoteDocs, error: docsError } = await supabase.from('checkin_documents').select('*').in('checkin_id', checkinIds)
    if (docsError) { console.error('[CheckinSync] Error fetching checkin_documents:', docsError.message) }
    else if (remoteDocs?.length) {
      for (const row of remoteDocs) {
        await db.insert(checkinDocuments).values({
          id: row.id, checkinId: row.checkin_id, documentId: row.document_id,
          completedAt: row.completed_at ? new Date(row.completed_at) : null, completedBy: row.completed_by,
          createdAt: row.created_at ? new Date(row.created_at) : null, updatedAt: row.updated_at ? new Date(row.updated_at) : null, syncedAt: now,
        }).onConflictDoUpdate({
          target: checkinDocuments.id,
          set: { completedAt: row.completed_at ? new Date(row.completed_at) : null, completedBy: row.completed_by, updatedAt: row.updated_at ? new Date(row.updated_at) : null, syncedAt: now },
        })
      }
    }
    lastSyncTime = now.toISOString()
    console.log(`[CheckinSync] Pulled ${remoteCheckins.length} checkins, ${remoteDocs?.length || 0} documents`)
  } catch (err) { console.error('[CheckinSync] Unexpected error:', err.message) }
}
