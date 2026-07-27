export function createResolver(roster) {
  const byEpc = new Map(roster.map(r => [String(r.rfid_epc).toUpperCase(), r.bib_number]))
  const unknown = new Map() // epc -> lastSeenAt ISO
  return {
    knownCount: byEpc.size,
    resolve(epc) {
      const bib = byEpc.get(epc)
      if (bib == null) { unknown.set(epc, new Date().toISOString()); return null }
      return bib
    },
    unknownList() {
      return [...unknown.entries()].map(([epc, lastSeenAt]) => ({ epc, lastSeenAt }))
    },
  }
}
