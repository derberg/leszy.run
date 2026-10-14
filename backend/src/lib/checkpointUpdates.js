// The column changes a PATCH /checkpoints/:id body asks for.
//
// A body that changes only categoryIds still has to write the checkpoint row: its
// category links have no synced_at of their own and are pushed with the checkpoint
// (sync/checkpointLinks.js), so the row must turn dirty. Without this the update had
// no columns to set and the route answered 500 "No values to set".
export function checkpointUpdates(body) {
  const { name, kmMarker, categoryIds, private: isPrivate, isNearFinish } = body || {}
  const updates = {}
  if (name !== undefined) updates.name = name
  if (kmMarker !== undefined) updates.kmMarker = kmMarker
  if (isPrivate !== undefined) updates.private = isPrivate
  if (isNearFinish !== undefined) updates.isNearFinish = isNearFinish
  if (categoryIds !== undefined && !Object.keys(updates).length) updates.syncedAt = null
  return updates
}
