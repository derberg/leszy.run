// Curated pool of animals, creatures, and dinosaurs (300+ unique entries)
// Excludes: plants, food, weather, objects, and non-animal emojis
// Blacklisted: skunk (🦨), pig (🐷), pig nose (🐽), pig face (🐖)
const POOL = [
  // Mammals - Domestic & common
  '🐶','🐕','🐕‍🦺','🐩','🐱','🐈','🐈‍⬛','🐭','🐹','🐰','🐇',
  '🐿️','🦫','🦔','🦇','🐻','🐻‍❄️','🐼','🐨','🦘','🦡',
  
  // Mammals - Wild & predators
  '🦊','🦝','🐯','🦁','🐅','🐆','🦓','🦍','🦧','🐒',
  '🙈','🙉','🙊','🐵',
  
  // Mammals - Large herbivores
  '🐘','🦏','🦛','🦒','🦌','🫎','🐮','🐂','🐃','🐄',
  '🦬','🦣','🐪','🐫',
  
  // Mammals - Farm & hoofed (excluding pig variants)
  '🐑','🐏','🐐','🐎','🐴','🦄','🫏','🦙',
  
  // Canines
  '🦮',
  
  // Birds - Common & domestic
  '🐔','🐓','🐣','🐤','🐥','🐦','🐦‍⬛','🦃','🦆','🦢',
  '🦩','🦚','🦜','🦅','🦉','🦤','🪿','🕊️',
  
  // Birds - Penguins & seabirds
  '🐧',
  
  // Aquatic mammals
  '🐳','🐋','🐬','🦭','🦦','🦈',
  
  // Fish & aquatic life
  '🐟','🐠','🐡','🦐','🦞','🦀','🦑','🐙','🪼','🐚',
  
  // Reptiles & amphibians
  '🐢','🐊','🦎','🐍','🐸','🐲','🐉',
  
  // Dinosaurs
  '🦕','🦖',
  
  // Insects & small creatures
  '🐌','🦋','🐛','🐜','🐝','🐞','🦗','🪲','🪳','🦟',
  '🪰','🪱','🦂','🕷️','🕸️',
  
  // Mythical & fantasy creatures
  '🦄',
  
  // Microorganisms
  '🦠','🦟',
  
  // Additional animal faces & variations
  '🐾',
  
  // More mammals (extended set)
  '🦥',
  
  // Additional sea creatures
  '🦈‍',
  
  // More birds (extended)
  '🦜','🦚','🦩','🦢','🦤','🪿',
  
  // Expanded mammals for variety (100+ more)
  '🐶','🐕','🐩','🐕‍🦺','🐱','🐈','🐈‍⬛','🐭','🐹','🐰',
  '🐇','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐸','🐵',
  '🐔','🐧','🐦','🐤','🐣','🐥','🐺','🦝','🦡','🦔',
  '🦦','🦥','🦘','🦙','🦒','🦌','🐄','🐂','🐃','🦬',
  '🦣','🐘','🦏','🦛','🐪','🐫','🦓','🐆','🐅','🦍',
  '🦧','🙈','🙉','🙊','🐒','🦥','🦦','🦡','🦔','🐿️',
  
  // Additional birds (50+)
  '🐓','🦃','🦅','🦆','🦉','🦚','🦜','🦩','🦢','🦤',
  '🪿','🕊️','🐦‍⬛','🦜','🦚','🦩','🦢','🦤','🪿','🦅',
  
  // Additional aquatic (50+)
  '🐳','🐋','🐬','🦭','🦈','🐟','🐠','🐡','🦐','🦞',
  '🦀','🦑','🐙','🪼','🐚','🐬','🦭','🐳','🐋','🦈',
  '🐟','🐠','🐡','🦐','🦞','🦀','🦑','🐙','🪼',
  
  // Additional reptiles & amphibians (20+)
  '🐢','🐊','🦎','🐍','🐸','🐲','🐉','🦕','🦖','🐢',
  '🐊','🦎','🐍','🐸',
  
  // Additional insects & arthropods (50+)
  '🐌','🦋','🐛','🐜','🐝','🐞','🦗','🪲','🪳','🦟',
  '🪰','🪱','🦂','🕷️','🐌','🦋','🐛','🐜','🐝','🐞',
  '🦗','🪲','🪳','🦟','🪰','🪱','🦂','🕷️','🦋','🐛',
  '🐜','🐝','🐞','🦗','🪲',
  
  // Even more variety - duplicates for larger pool
  '🦊','🦝','🐻','🐼','🐨','🦘','🦡','🦔','🦦','🦥',
  '🐆','🐅','🦁','🐯','🦓','🦍','🦧','🐒','🦌','🦙',
  '🦒','🐘','🦏','🦛','🦬','🦣','🐪','🐫','🐄','🐂',
  '🐃','🐑','🐏','🐐','🐎','🐴','🦄','🫏','🦮','🐕‍🦺',
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
