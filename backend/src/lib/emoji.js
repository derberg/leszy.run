// Curated pool of visually distinct animal emojis (50 entries)
const POOL = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
  '🦁','🐮','🐷','🐸','🐵','🦄','🐝','🦋','🐢','🦎',
  '🐙','🦑','🦀','🐡','🐠','🐟','🦈','🐬','🦭','🦜',
  '🦚','🦩','🦢','🦔','🐿️','🦦','🦥','🦨','🦡','🐓',
  '🦃','🐕','🐈','🐅','🐆','🦓','🦍','🐘','🦒','🦘',
]

/**
 * Pick an emoji for a new participant in an event.
 * Prefers one not already used by other participants in the same event.
 * Falls back to a random pool entry if all are taken.
 *
 * @param {string[]} usedEmojis - emojis already assigned in this event
 * @returns {string}
 */
export function pickEmoji(usedEmojis) {
  const usedSet = new Set(usedEmojis)
  const available = POOL.filter(e => !usedSet.has(e))
  const source = available.length > 0 ? available : POOL
  return source[Math.floor(Math.random() * source.length)]
}
