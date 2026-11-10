// The one e-mail rule of online registration and login, shared by the edge functions and the
// browser (the @registration Vite alias). Plain ESM: runs in Deno and Node.
//
// It exists because the old check, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, took `zofia@gmail..com`: a
// captain typed a teammate's address with two dots, the server accepted it, and the consent
// e-mail and both reminders went nowhere. The rule is still permissive where real addresses are
// (plus-addressing, hyphens, IDN, punycode), and strict only where a typo is certain:
// - no whitespace, and none of `,` `(` `)` `"` `\` `<` `>` or a control character, which no real
//   address needs and which change meaning in a PostgREST filter or a mail header (loginEmail.js);
// - local part: 1..64 characters, no leading or trailing dot, no two dots in a row;
// - domain: at least two labels of 1..63 letters, digits or hyphens, none starting or ending
//   with a hyphen, so no empty label (`..`, a leading or trailing dot);
// - top-level domain: two or more letters, or a punycode `xn--` label (`xn--p1ai`, .рф).
// Callers trim and lower-case first; the rule itself is case-insensitive.

export const EMAIL_MAX = 254
export const EMAIL_INVALID_MESSAGE = 'Podaj poprawny adres e-mail.'

const LOCAL_CHAR_RE = /^[^\s@,()"\\<>\u0000-\u001f\u007f]+$/u
const LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u
const TLD_RE = /^(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/iu

/** @returns {boolean} */
export function isValidEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > EMAIL_MAX) return false
  const at = email.lastIndexOf('@')
  if (at <= 0 || email.indexOf('@') !== at) return false
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (local.length > 64 || !LOCAL_CHAR_RE.test(local)) return false
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return false
  return TLD_RE.test(labels[labels.length - 1])
}

// Providers Polish runners use. An address at one of them is never "corrected".
export const KNOWN_DOMAINS = [
  'gmail.com', 'googlemail.com', 'wp.pl', 'o2.pl', 'onet.pl', 'onet.eu', 'op.pl', 'poczta.onet.pl',
  'vp.pl', 'interia.pl', 'interia.eu', 'poczta.fm', 'gazeta.pl', 'tlen.pl', 'buziaczek.pl',
  'yahoo.com', 'yahoo.pl', 'mail.com', 'gmx.com', 'gmx.de', 'aol.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
]

// Typos a distance of one cannot reach, or that distance would send elsewhere.
const TYPOS = {
  'gmail.pl': 'gmail.com', 'gmial.pl': 'gmail.com', 'gamil.pl': 'gmail.com', 'gmail.com.pl': 'gmail.com',
  'gmal.co': 'gmail.com', 'gmali.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gnail.co': 'gmail.com',
  'wp.com': 'wp.pl', 'wppl': 'wp.pl', 'wp.p': 'wp.pl', 'wp.l': 'wp.pl',
  'o2.com': 'o2.pl', 'o2pl': 'o2.pl', 'onet.com': 'onet.pl', 'interia.com': 'interia.pl',
}

// Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps), capped: anything
// above `max` is reported as max + 1.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2 = new Array(b.length + 1).fill(0)
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1)
      cur[j] = d
      if (d < rowMin) rowMin = d
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]
    prev = cur
  }
  return prev[b.length]
}

function closestKnown(domain) {
  if (TYPOS[domain]) return TYPOS[domain]
  let best = null
  let bestD = Infinity
  let tie = false
  for (const known of KNOWN_DOMAINS) {
    // One edit on a short domain (wp.pl, o2.pl), two on a longer one (interia.pl, gmail.com).
    const max = known.length <= 6 ? 1 : 2
    const d = distance(domain, known, max)
    if (d > max) continue
    if (d < bestD) { best = known; bestD = d; tie = false } else if (d === bestD) tie = true
  }
  return tie ? null : best
}

/**
 * „Czy chodziło o …?”: the address with a provider typo fixed (gmial.com, gmail.con, gmail..com,
 * wp.p, interia.pl.), or null. A suggestion is only ever offered; it never blocks submitting,
 * because a domain one letter from a provider can be a real one.
 * @param {string} email
 * @returns {string|null}
 */
export function suggestEmail(email) {
  if (typeof email !== 'string') return null
  const t = email.trim().toLowerCase()
  const at = t.lastIndexOf('@')
  if (at <= 0) return null
  const local = t.slice(0, at)
  const typed = t.slice(at + 1)
  if (!typed || KNOWN_DOMAINS.includes(typed)) return null
  // Doubled, leading and trailing dots, and a comma for a dot, are fixed before the lookup.
  const domain = typed.replace(/,/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '')
  const fixed = KNOWN_DOMAINS.includes(domain) ? domain : closestKnown(domain)
  if (!fixed || fixed === typed) return null
  const suggestion = `${local}@${fixed}`
  return isValidEmail(suggestion) ? suggestion : null
}

/**
 * What is wrong with an address, in words a runner can act on, or null when it passes
 * isValidEmail. The forms show it on blur; the server answers EMAIL_INVALID_MESSAGE.
 * @param {string} email trimmed
 * @returns {string|null}
 */
export function emailProblem(email) {
  const t = typeof email === 'string' ? email.trim() : ''
  if (isValidEmail(t.toLowerCase())) return null
  if (!t) return EMAIL_INVALID_MESSAGE
  if (/\s/.test(t)) return 'Adres e-mail nie może zawierać spacji.'
  const ats = t.split('@').length - 1
  if (ats !== 1) return 'Adres e-mail musi zawierać jeden znak @.'
  const [local, domain] = t.split('@')
  if (!local) return 'Brakuje części przed znakiem @.'
  if (!domain) return 'Brakuje części po znaku @.'
  if (t.includes('..')) return 'Adres ma dwie kropki obok siebie.'
  if (/^\.|\.$/.test(local) || /^\.|\.$/.test(domain)) return 'Kropka nie może stać na początku ani na końcu adresu.'
  if (!domain.includes('.')) return 'Brakuje końcówki domeny, np. .pl lub .com.'
  return EMAIL_INVALID_MESSAGE
}
