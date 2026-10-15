// Crossing detector for checkpoints, the same rule as the finish in the
// backend's crossingDetector.js. The first read of a tag opens a pass. Every
// stronger read becomes the new peak. The pass closes once quietMs (2 s) go by
// with no stronger read, and never later than maxPassMs (6 s) after its first
// read, so a runner who stops at an aid station still confirms on time. The
// pass is timestamped at the PEAK reading (closest physical approach). One pass
// per EPC per session (course rule: checkpoints are passed once; out-and-back =
// two logical checkpoints).
//
// The pass used to be a fixed 3 s window from the first read. At the 2026-10-15
// rehearsal the finish gate heard bib 4 4.5 s before its peak, and that window
// timed it 1.58 s early.
export class Confirmer {
  constructor({ quietMs = 2000, maxPassMs = 6000, onConfirm }) {
    this.quietMs = quietMs
    this.maxPassMs = maxPassMs
    this.onConfirm = onConfirm
    this.inRange = new Map() // epc -> { firstAt, peakRssi, peakTime, timer }
    this.seen = new Set()
  }

  seed(epcs) {
    for (const e of epcs) {
      this.seen.add(e)
      const cur = this.inRange.get(e)
      if (cur) {
        clearTimeout(cur.timer)
        this.inRange.delete(e)
      }
    }
  }

  read({ epc, rssiCdbm, at }) {
    if (this.seen.has(epc)) return
    const rssi = rssiCdbm ?? -9999
    let cur = this.inRange.get(epc)
    if (cur && (at - cur.firstAt >= this.maxPassMs || at - cur.peakTime >= this.quietMs)) {
      // The timer is due but has not run yet: this read is after the pass.
      this.#confirm(epc)
      return
    }
    if (!cur) {
      cur = { firstAt: at, peakRssi: -Infinity, peakTime: at, timer: null }
      this.inRange.set(epc, cur)
    }
    if (rssi > cur.peakRssi) {
      cur.peakRssi = rssi
      cur.peakTime = at
      clearTimeout(cur.timer)
      const untilCap = this.maxPassMs - (at - cur.firstAt)
      cur.timer = setTimeout(() => this.#confirm(epc), Math.min(this.quietMs, untilCap))
    }
  }

  #confirm(epc) {
    const cur = this.inRange.get(epc)
    if (!cur) return
    clearTimeout(cur.timer)
    this.inRange.delete(epc)
    this.seen.add(epc)
    this.onConfirm({ epc, peakTime: cur.peakTime, peakRssi: cur.peakRssi })
  }

  get inRangeCount() { return this.inRange.size }
  get confirmedCount() { return this.seen.size }

  stop() {
    for (const { timer } of this.inRange.values()) clearTimeout(timer)
    this.inRange.clear()
  }
}
