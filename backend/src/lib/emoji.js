// Curated pool of animals, creatures, and dinosaurs (unique entries only)
// Excludes: plants, food, weather, objects, non-animal emojis
// Blacklisted: skunk (🦨), pig variants (🐷🐽🐖), ugly insects (ant, cricket,
// cockroach, mosquito, fly, worm, spider, web), microbe (🦠)
const POOL = [
  // Mammals - Domestic & common
  '🐶','🐕','🐕‍🦺','🐩','🐱','🐈','🐈‍⬛','🐭','🐹','🐰','🐇',
  '🐿️','🦫','🦔','🦇','🐻','🐻‍❄️','🐼','🐨','🦘','🦡','🐁',

  // Mammals - Wild & predators
  '🦊','🦝','🐯','🦁','🐅','🐆','🦓','🦍','🦧','🐒',
  '🙈','🙉','🙊','🐵','🐺','🦥',

  // Mammals - Large herbivores
  '🐘','🦏','🦛','🦒','🦌','🫎','🐮','🐂','🐃','🐄',
  '🦬','🦣','🐪','🐫',

  // Mammals - Farm & hoofed
  '🐑','🐏','🐐','🐎','🐴','🫏','🦙','🐗',

  // Canines
  '🦮',

  // Birds
  '🐔','🐓','🐣','🐤','🐥','🐦','🐦‍⬛','🦃','🦆','🦢',
  '🦩','🦚','🦜','🦅','🦉','🦤','🪿','🕊️','🐧',

  // Aquatic mammals
  '🐳','🐋','🐬','🦭','🦦','🦈',

  // Fish & aquatic life
  '🐟','🐠','🐡','🦐','🦞','🦀','🦑','🐙','🪼','🐚',

  // Reptiles & amphibians
  '🐢','🐊','🦎','🐍','🐸',

  // Mythical creatures & dinosaurs
  '🐲','🐉','🦕','🦖','🦄','🐦‍🔥',
  '👻','👽','🧚','🧛','🧜','🧝','🧞','🧟','🧙',
  '🦸','🦹','🥷',

  // Insects & small creatures (curated — only the nice ones)
  '🐌','🦋','🐛','🐝','🐞','🪲','🦂',

  // Animal faces & variations
  '🐾',
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
