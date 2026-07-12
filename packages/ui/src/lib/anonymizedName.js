/**
 * Returns the display name for a participant/profile, respecting soft-delete.
 *
 * @param {object} entity - participant or profile row
 * @returns {{ displayName: string, isAnonymized: boolean, tooltip: string|null }}
 */
export function anonymizedName(entity) {
  const isAnonymized = Boolean(entity?.deleted_at || entity?.deletedAt)
  if (isAnonymized) {
    return {
      displayName: 'Uczestnik anonimowy',
      isAnonymized: true,
      tooltip: 'Konto użytkownika zostało usunięte. Wynik pozostaje jako część archiwum biegu.',
    }
  }
  const first = entity?.firstName || entity?.first_name || ''
  const last = entity?.lastName || entity?.last_name || ''
  const display = entity?.displayName || entity?.display_name
  return {
    displayName: display || `${first} ${last}`.trim() || 'Uczestnik',
    isAnonymized: false,
    tooltip: null,
  }
}
