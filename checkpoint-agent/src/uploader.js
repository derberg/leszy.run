// Flush loop: pending queue rows → Supabase checkpoint_observations, in order,
// one at a time (volume is tiny; per-row inserts make partial progress and
// duplicate handling trivial). 23505 unique-violation = the row already exists
// (retry after half-failed batch, second Pi on the same checkpoint, volunteer
// beat us to it) — first observation wins by design, count it as uploaded.
export class Uploader {
  constructor({ queue, supabase, intervalMs = 5000 }) {
    this.queue = queue
    this.supabase = supabase
    this.intervalMs = intervalMs
    this.timer = null
    this.lastUploadAt = null
    this.lastError = null
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { this.flush() }, this.intervalMs)
  }

  stop() { clearInterval(this.timer); this.timer = null }

  async flush() {
    for (const rowObj of this.queue.pending()) {
      const { epc, ...insertRow } = rowObj
      let error
      try {
        ;({ error } = await this.supabase.from('checkpoint_observations').insert(insertRow))
      } catch (err) {
        error = { message: err.message }
      }
      if (error && error.code !== '23505') {
        this.lastError = error.message
        return // keep row pending; retry on next tick
      }
      await this.queue.advance(1)
      this.lastUploadAt = new Date().toISOString()
    }
    if (this.queue.counts.pending === 0) this.lastError = null
  }

  get status() { return { lastUploadAt: this.lastUploadAt, lastError: this.lastError } }
}
