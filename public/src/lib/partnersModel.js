// The wizard's „Partnerzy” step: the dialog's form as organizer-partners takes it, the pieces of a
// list row, and the ↑ ↓ order. The server validates everything (_shared/registration/partners.js);
// a value the form cannot judge goes as typed, so a 422 names its field.

const text = (v) => {
  const t = String(v ?? '').trim()
  return t === '' ? null : t
}

/**
 * The dialog's form → organizer-partners' create / update fields.
 * @param {{ name?: string, note?: string, websiteUrl?: string, isPublic?: boolean }} form
 * @returns {{ name: string|null, note: string|null, websiteUrl: string|null, isPublic: boolean }}
 */
export function partnerRequest(form) {
  return {
    name: text(form.name),
    note: text(form.note),
    websiteUrl: text(form.websiteUrl),
    isPublic: form.isPublic !== false,
  }
}

/** The dialog's starting form: a new partner is shown on the event page. */
export function partnerForm(partner) {
  return {
    name: partner?.name ?? '',
    note: partner?.note ?? '',
    websiteUrl: partner?.websiteUrl ?? '',
    isPublic: partner ? partner.isPublic !== false : true,
  }
}

/** „https://www.sklep.pl/x” → „sklep.pl”; null for no address or one that does not parse. */
export function linkHost(url) {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || null
  } catch {
    return null
  }
}

/** The box shown in place of a logo: the first letters of the first two words. */
export function initials(name) {
  const words = String(name ?? '').split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean)
  if (!words.length) return '?'
  return words.slice(0, 2).map((w) => [...w][0]).join('').toLocaleUpperCase('pl-PL')
}

/** A partner in the code dialog's select: a hidden one says so. */
export function partnerOptionLabel(p) {
  return p.isPublic === false ? `${p.name} (ukryty)` : p.name
}

/**
 * The order after moving `id` one place up (-1) or down (+1): every id once, as `reorder` needs.
 * null when it cannot move (already first or last, or unknown).
 */
export function moveId(ids, id, delta) {
  const at = ids.indexOf(id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= ids.length) return null
  const out = [...ids]
  ;[out[at], out[to]] = [out[to], out[at]]
  return out
}
