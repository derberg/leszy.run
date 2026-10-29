// Polish count forms. 1 → `one`; 2–4, 22–24, 32–34 … (but not 12–14) → `few`; every other
// count, 0 included → `many`. „1 opłacone · 3 opłacone · 5 opłaconych”, „1 czeka · 2 czekają”.

/** The form of a word for `n` (a non-negative integer). */
export function pluralPl(n, one, few, many) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pluralPl: not a count: ${n}`)
  if (n === 1) return one
  const tens = n % 100
  const units = n % 10
  if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return few
  return many
}

/** „<n> <form>”, with `forms` = [one, few, many]. */
export const countPl = (n, forms) => `${n} ${pluralPl(n, ...forms)}`
