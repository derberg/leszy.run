/** PL61109010140000071219812874 -> "PL61 … 2874" (first 4 + last 4); null when there is no number. */
export function maskIban(iban) {
  return iban ? `${iban.slice(0, 4)} … ${iban.slice(-4)}` : null
}
