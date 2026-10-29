// Ruling P3-R2: a dpay payload (register answer, IPN, details, refund) is redacted before it
// is written to payment_events. The payer e-mail is personal data kept for 5 years with the
// accounting records, so it is stored only as payment_events.email_sha256. The database
// refuses an `email` key at any depth as a backstop; this is what keeps a log write from
// ever hitting it. Plain ESM, no runtime APIs: runs in Deno and Node.

export const EMAIL_MASK = '[email]'

// email, Email, e_mail, e-mail, payerEmail, buyer_email: a key that names an address.
// emailVerified or email_sha256 name something else and stay.
const EMAIL_KEY = /e[-_]?mail$/i
const EMAIL_VALUE = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[a-z]{2,}/gi

/** A deep copy of `value` with every e-mail key dropped and every address in a string masked. */
export function redactDpay(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.replace(EMAIL_VALUE, EMAIL_MASK)
  if (Array.isArray(value)) return value.map(redactDpay)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) {
      if (EMAIL_KEY.test(key)) continue
      out[key] = redactDpay(v)
    }
    return out
  }
  return value
}
