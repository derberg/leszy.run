import { eq, inArray, isNotNull } from 'drizzle-orm'
import { checkpoints, checkpointCategories } from '../db/schema.js'

// checkpoint_categories says which categories pass a checkpoint; no rows means all of
// them. The table has no id and no synced_at, so neither sync worker carried it: a
// checkpoint narrowed to two categories on the Mac stayed open to every category in
// Supabase and on the Pi (Wilczy Półmaraton, 2026-10-14: "Premia lotna" excluded
// Nordic Walking locally and nowhere else).
//
// So the links travel WITH their checkpoint row. A link change always touches the
// checkpoint row (see the PATCH route), which makes the checkpoint dirty, and the
// push worker then replaces that checkpoint's whole link set in Supabase before it
// marks the row synced. The pull replaces a CLEAN local checkpoint's link set with
// the remote one, under the same "never clobber a dirty row" rule as configSync.

const PAGE = 1000 // PostgREST hard-caps a response at 1000 rows

/** rows [{ checkpoint_id|checkpointId, category_id|categoryId }] → Map<checkpointId, string[] sorted> */
export function groupLinks(rows) {
  const map = new Map()
  for (const r of rows || []) {
    const cp = r.checkpoint_id ?? r.checkpointId
    const cat = r.category_id ?? r.categoryId
    if (!map.has(cp)) map.set(cp, [])
    map.get(cp).push(cat)
  }
  for (const list of map.values()) list.sort()
  return map
}

export function sameLinks(a = [], b = []) {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((v, i) => v === y[i])
}

/**
 * Which clean local checkpoints need their links replaced by the remote set.
 * Only checkpoints that still exist remotely are considered: deletes are not
 * propagated, so a checkpoint missing from Supabase says nothing about its links.
 * @returns {Array<{ checkpointId: string, categoryIds: string[] }>}
 */
export function linksToPull({ cleanLocalIds, remoteCheckpointIds, localLinks, remoteLinks }) {
  const remoteIds = new Set(remoteCheckpointIds)
  const out = []
  for (const id of cleanLocalIds) {
    if (!remoteIds.has(id)) continue
    const remote = remoteLinks.get(id) || []
    if (!sameLinks(localLinks.get(id) || [], remote)) out.push({ checkpointId: id, categoryIds: remote })
  }
  return out
}

/**
 * Push: replace the Supabase link set of each given checkpoint with the local one.
 * Call after the checkpoint rows themselves were upserted (FK) and before they are
 * marked synced, so a failure leaves them dirty and the next cycle retries.
 * @returns {Promise<string|null>} error message, or null
 */
export async function pushCheckpointLinks(supabase, db, checkpointIds) {
  if (!checkpointIds.length) return null
  const local = await db.select().from(checkpointCategories)
    .where(inArray(checkpointCategories.checkpointId, checkpointIds))

  const del = await supabase.from('checkpoint_categories').delete().in('checkpoint_id', checkpointIds)
  if (del.error) return del.error.message

  if (local.length) {
    const ins = await supabase.from('checkpoint_categories')
      .insert(local.map(l => ({ checkpoint_id: l.checkpointId, category_id: l.categoryId })))
    if (ins.error) return ins.error.message
  }
  return null
}

async function fetchAll(supabase, table, columns) {
  const rows = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).range(offset, offset + PAGE - 1)
    if (error) throw new Error(`fetch ${table}: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

/** Pull: bring clean local checkpoints' link sets in line with Supabase. */
export async function pullCheckpointLinks(supabase, db) {
  const remoteCheckpoints = await fetchAll(supabase, 'checkpoints', 'id')
  const remoteLinks = groupLinks(await fetchAll(supabase, 'checkpoint_categories', 'checkpoint_id, category_id'))

  const clean = await db.select({ id: checkpoints.id }).from(checkpoints).where(isNotNull(checkpoints.syncedAt))
  const localLinks = groupLinks(await db.select().from(checkpointCategories))

  const changes = linksToPull({
    cleanLocalIds: clean.map(c => c.id),
    remoteCheckpointIds: remoteCheckpoints.map(c => c.id),
    localLinks,
    remoteLinks,
  })

  let applied = 0
  for (const { checkpointId, categoryIds } of changes) {
    try {
      await db.transaction(async (tx) => {
        // Lock the checkpoint and re-check it is still clean: a local edit that landed
        // since the snapshot above wins, exactly as in configSync's guarded upsert. The
        // PATCH route updates the checkpoint row before its links, so it waits on this lock.
        const [row] = await tx.select({ syncedAt: checkpoints.syncedAt }).from(checkpoints)
          .where(eq(checkpoints.id, checkpointId)).for('update')
        if (!row || row.syncedAt === null) return
        await tx.delete(checkpointCategories).where(eq(checkpointCategories.checkpointId, checkpointId))
        if (categoryIds.length) {
          await tx.insert(checkpointCategories)
            .values(categoryIds.map(categoryId => ({ checkpointId, categoryId })))
        }
        applied++
      })
    } catch (e) {
      // e.g. a category not pulled yet (FK) — the next poll retries
      console.error(`[ConfigSync] checkpoint_categories ${checkpointId}: ${e.message}`)
    }
  }
  if (applied) console.log(`[ConfigSync] checkpoint_categories: replaced links of ${applied} checkpoint(s)`)
}
