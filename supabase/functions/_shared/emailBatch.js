// Sending one message to many people in batches. Plain ESM, no runtime APIs,
// so node tests run it with a fake sender.
//
// SendGrid takes up to 1000 personalizations per request; each recipient gets
// their own personalization, so nobody sees the other addresses.

export const BATCH_SIZE = 1000

/**
 * @param {string[]} recipients
 * @param {(batch: string[]) => Promise<{ ok: boolean }>} sendBatch one request per batch
 * @returns {Promise<{ sent: number, failed: number, batches: number }>} a batch whose request
 *   failed (non-OK answer or thrown error) counts as not sent
 */
export async function sendInBatches(recipients, sendBatch, size = BATCH_SIZE) {
  let sent = 0
  let failed = 0
  let batches = 0
  for (let i = 0; i < recipients.length; i += size) {
    const batch = recipients.slice(i, i + size)
    batches++
    let ok = false
    try {
      ok = (await sendBatch(batch))?.ok === true
    } catch (err) {
      console.error('email batch failed:', err?.message)
    }
    if (ok) sent += batch.length
    else failed += batch.length
  }
  return { sent, failed, batches }
}
