// Płatności „Kody rabatowe” (A6, Plan 7): organizer-vouchers' rows as the table shows them, and
// the forms as the request organizer-vouchers takes. The server validates everything; a value the
// form cannot read as a whole number goes as typed, so the 422 names its field.

/** 'YYYY-MM-DD' → 'd.mm.yyyy' */
const day = (iso) => {
  const [y, m, d] = iso.split('-')
  return `${Number(d)}.${m}.${y}`
}

/**
 * @param {{ id, code, percent, used, maxUses, validUntil: string|null, partner: { name }|null, disabled }} v
 * @param {{ today: string }} o today's Warsaw day: „Ważny do” D lasts through the whole of D
 */
export function voucherView(v, { today }) {
  const state = v.disabled ? 'WYŁĄCZONY'
    : v.used >= v.maxUses ? 'WYKORZYSTANY'
      : v.validUntil && v.validUntil < today ? 'WYGASŁ'
        : null
  return {
    id: v.id,
    code: v.code,
    discount: `−${v.percent}%`,
    uses: `${v.used} / ${v.maxUses}`,
    partner: v.partner?.name ?? '—',
    validUntil: v.validUntil ? day(v.validUntil) : '—',
    state,
    canDisable: !v.disabled,
    canDelete: v.used === 0,
  }
}

const whole = (text) => {
  const t = String(text ?? '').trim()
  return /^\d+$/.test(t) ? Number(t) : t
}
const orNull = (text) => (String(text ?? '').trim() === '' ? null : String(text).trim())

/**
 * „+ Kod” → create's body; with `generate`, „Wygeneruj kody” → generate's (n and a prefix, no code
 * and no limit: generated codes are single-use).
 */
export function voucherRequest(form, { generate = false } = {}) {
  const common = {
    percent: whole(form.percent),
    validUntil: orNull(form.validUntil),
    partnerId: orNull(form.partnerId),
    categoryIds: form.categoryIds ?? [],
  }
  if (generate) return { n: whole(form.n), prefix: orNull(form.prefix), ...common }
  const code = orNull(form.code)
  return { ...(code ? { code } : {}), percent: common.percent, maxUses: whole(form.maxUses), ...common }
}
