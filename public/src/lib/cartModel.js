// The runner's cart on RA1, RA2 and RA4 (Plan 7, task 8a), as pure functions: the extras a person
// may order, the donation a runner types, and RA4's lines. Money is integer grosze through the
// same modules the edge functions use (money.js, pricing.js), so the page shows the total
// create-order computes. Nothing here is payable to LESZY.RUN.
import { formatPln } from '../../../supabase/functions/_shared/registration/money.js'
import { cartAmounts, voucherLineLabel } from '../../../supabase/functions/_shared/registration/pricing.js'
import { parsePriceGrosze } from '../../../supabase/functions/_shared/registration/sections.js'
import { DONATION_MESSAGE } from '../../../supabase/functions/_shared/registration/cart.js'
import { warsawToday } from '../../../supabase/functions/_shared/registration/dates.js'

// Ruling 7: a donation is 1–5 000 zł, chosen from „0”, „+20 zł”, „+50 zł” or „inna”.
export const DONATION_MIN = 100
export const DONATION_MAX = 500_000
export const DONATION_CHIPS = [
  { key: 'none', label: '0', grosze: 0 },
  { key: '20', label: '+20 zł', grosze: 2000 },
  { key: '50', label: '+50 zł', grosze: 5000 },
  { key: 'other', label: 'inna', grosze: null },
]
export const MAX_EXTRA_QTY = 10

/**
 * „inna”: what the runner typed, in złote („12,5”, „12.50”, „5 000”), as grosze.
 * → { ok: true, grosze } | { ok: false, error }. 0 and anything past 5 000 zł are refused.
 */
export function parseDonationInput(input) {
  const s = String(input ?? '').replace(/[\s  ]/g, '').replace(/zł$/i, '')
  const grosze = s === '' ? null : parsePriceGrosze(s)
  if (grosze == null || grosze < DONATION_MIN || grosze > DONATION_MAX) return { ok: false, error: DONATION_MESSAGE }
  return { ok: true, grosze }
}

/** The donation of the chosen chip, or of „inna”'s input. → { ok, grosze, error? } */
export function donationOf(chip, otherInput) {
  if (chip === 'other') return parseDonationInput(otherInput)
  const c = DONATION_CHIPS.find((x) => x.key === chip)
  return { ok: true, grosze: c?.grosze ?? 0 }
}

/** RA4 offers the chips only on a charity event with donations on (ruling 7). */
export const donationsOffered = (raw) => raw?.isCharity === true && raw?.donationsEnabled === true

/**
 * The extras a person in `categoryId` may still order, from registration_raw's `extras`: offered
 * in that competition (none named = every one), and orderable today (Warsaw) or with no deadline.
 * A variant with nothing left stays, marked soldOut, so the picker can show „brak”.
 */
export function orderableExtras(extras, categoryId, now = new Date()) {
  const today = warsawToday(now)
  return (extras ?? [])
    .filter((x) => !x.categoryIds?.length || x.categoryIds.includes(categoryId))
    .filter((x) => !x.orderUntil || x.orderUntil >= today)
    .map((x) => ({
      id: x.id,
      name: x.name,
      price: x.price,
      priceLabel: formatPln(x.price),
      imageUrl: x.imageUrl ?? null,
      variants: (x.variants ?? []).map((v) => ({ id: v.id, label: v.label, soldOut: !(v.left > 0) })),
    }))
}

/** Every variant of the extra is sold out. */
export const soldOut = (extra) => extra.variants.length === 0 || extra.variants.every((v) => v.soldOut)

/** RA4's line under a person: „Koszulka · M · 45,00 zł”, „Koszulka · M · 2 szt. · 90,00 zł”. */
export function extraLineLabel({ name, variantLabel, qty, price }) {
  const parts = [name]
  if (variantLabel && variantLabel !== name) parts.push(variantLabel)
  if (qty > 1) parts.push(`${qty} szt.`)
  parts.push(formatPln(price * qty))
  return parts.join(' · ')
}

/**
 * A card's picks as RA4 lines and as the request's extras. `picks` is the card's
 * { [extraId]: { variantId, qty } }; only orderable extras with qty above 0 count.
 * → [{ extraId, variantId, name, variantLabel, price, qty }]
 */
export function pickedExtras(picks, offered) {
  const out = []
  for (const x of offered ?? []) {
    const p = picks?.[x.id]
    if (!p || !(p.qty > 0)) continue
    const v = x.variants.find((y) => y.id === p.variantId && !y.soldOut)
    if (!v) continue
    out.push({ extraId: x.id, variantId: v.id, name: x.name, variantLabel: v.label, price: x.price, qty: p.qty })
  }
  return out
}

/**
 * RA4's amounts for its lines and the donation, through cartAmounts (D7-21). A line is
 * { priceGrosze (the list price), voucher: { code, percent }|null, extras: [{ price, qty }] }.
 * → cartAmounts' answer plus per-line `voucherLabel` (null without a code).
 */
export function checkoutCart(lines, donation = 0) {
  const a = cartAmounts({
    people: lines.map((l) => ({
      listPrice: l.priceGrosze,
      voucherPercent: l.voucher?.percent ?? null,
      extras: (l.extras ?? []).map((e) => ({ price: e.price, qty: e.qty })),
    })),
    donation,
  })
  return {
    ...a,
    voucherLabels: a.lines.map((x, i) => (lines[i].voucher
      ? voucherLineLabel({ listPrice: x.listPrice, percent: lines[i].voucher.percent, code: lines[i].voucher.code, price: x.price })
      : null)),
  }
}
