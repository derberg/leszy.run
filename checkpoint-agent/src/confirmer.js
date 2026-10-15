// Crossing detector for checkpoints. The first read of a tag opens a pass that
// lasts a fixed passWindowMs (3 s). Reads inside the window only move the peak;
// they never extend it. When the window ends the pass is confirmed, timestamped
// at the PEAK reading (closest physical approach). A tag is heard from about
// 5 m (measured 2026-10-15), so a runner is through the read zone well inside
// 3 s, and a runner who stops at an aid station still confirms on time instead
// of holding the pass open. One pass per EPC per session (course rule:
// checkpoints are passed once; out-and-back = two logical checkpoints).
export class Confirmer {
  constructor({ passWindowMs = 3000, onConfirm }) {
    this.passWindowMs = passWindowMs
    this.onConfirm = onConfirm
    this.inRange = new Map() // epc -> { peakRssi, peakTime, timer }
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
    const cur = this.inRange.get(epc)
    if (!cur) {
      this.inRange.set(epc, {
        peakRssi: rssi,
        peakTime: at,
        timer: setTimeout(() => this.#confirm(epc), this.passWindowMs),
      })
      return
    }
    if (rssi > cur.peakRssi) { cur.peakRssi = rssi; cur.peakTime = at }
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
    for (const { timer } of this.inRange.values()) clearTimeout(timer)
    this.inRange.clear()
  }
}
