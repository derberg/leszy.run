// Pure helpers for the bib-office QR scanner (AdminCheckin.jsx). Kept free of
// browser APIs so node --test can cover them.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// How long the same code is ignored after it was handled. The camera keeps
// running while the result is on screen, so without this one code held up to
// the lens is looked up again on every frame.
export const REPEAT_COOLDOWN_MS = 3000

/**
 * The participant id carried by a scanned code, or null when the code is not
 * ours. Checkin.jsx encodes `<origin>/events/<slug>/admin/checkin?p=<id>`; a
 * bare id is accepted too.
 * @param {string} text
 * @returns {string|null}
 */
export function participantIdFromQr(text) {
  const raw = (text || '').trim()
  let candidate = raw
  try {
    candidate = new URL(raw).searchParams.get('p') || ''
  } catch {}
  return UUID_RE.test(candidate) ? candidate : null
}

/**
 * @param {{ text: string, at: number } | null} last the last handled code
 * @param {string} text
 * @param {number} now
 */
export function isRepeatScan(last, text, now) {
  return !!last && last.text === text && now - last.at < REPEAT_COOLDOWN_MS
}
