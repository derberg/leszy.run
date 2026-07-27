// Simplified crossing detector for checkpoints. Exit-triggered: a pass is
// confirmed when a tag goes silent for goneWindowMs, timestamped at the PEAK
// reading (closest physical approach) — correct ordering even when runners
// linger at an aid station. One pass per EPC per session (course rule:
// checkpoints are passed once; out-and-back = two logical checkpoints).
// No maxTimer/fallback here — that is finish-line-only semantics.
export class Confirmer {
  constructor({ goneWindowMs = 3000, onConfirm }) {
    this.goneWindowMs = goneWindowMs
    this.onConfirm = onConfirm
    this.inRange = new Map() // epc -> { peakRssi, peakTime, goneTimer }
    this.seen = new Set()
  }

  seed(epcs) {
    for (const e of epcs) {
      this.seen.add(e)
      const cur = this.inRange.get(e)
      if (cur) {
        clearTimeout(cur.goneTimer)
        this.inRange.delete(e)
      }
    }
  }

  read({ epc, rssiCdbm, at }) {
    if (this.seen.has(epc)) return
    const rssi = rssiCdbm ?? -9999
    const cur = this.inRange.get(epc)
    if (!cur) {
      this.inRange.set(epc, {
        peakRssi: rssi,
        peakTime: at,
        goneTimer: setTimeout(() => this.#confirm(epc), this.goneWindowMs),
      })
      return
    }
    if (rssi > cur.peakRssi) { cur.peakRssi = rssi; cur.peakTime = at }
    clearTimeout(cur.goneTimer)
    cur.goneTimer = setTimeout(() => this.#confirm(epc), this.goneWindowMs)
  }

  #confirm(epc) {
    const cur = this.inRange.get(epc)
    if (!cur) return
    this.inRange.delete(epc)
    this.seen.add(epc)
    this.onConfirm({ epc, peakTime: cur.peakTime, peakRssi: cur.peakRssi })
  }

  get inRangeCount() { return this.inRange.size }
  get confirmedCount() { return this.seen.size }

  stop() {
    for (const { goneTimer } of this.inRange.values()) clearTimeout(goneTimer)
    this.inRange.clear()
  }
}
