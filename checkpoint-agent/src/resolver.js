export function createResolver(roster) {
  const byEpc = new Map(roster.map(r => [String(r.rfid_epc).toUpperCase(), r.bib_number]))
  const unknown = new Map() // epc -> lastSeenAt ISO
  return {
    knownCount: byEpc.size,
    resolve(epc) {
      const bib = byEpc.get(String(epc).toUpperCase())
      if (bib == null) { unknown.set(epc, new Date().toISOString()); return null }
      return bib
    },
    // Non-mutating lookup for display purposes (e.g. the live raw-reads
    // feed) — returns the bib for a known EPC or null, WITHOUT recording the
    // EPC as unknown. Unlike resolve(), calling this must never affect
    // unknownList()/knownCount bookkeeping.
    lookup(epc) {
      const bib = byEpc.get(String(epc).toUpperCase())
      return bib == null ? null : bib
    },
    unknownList() {
      return [...unknown.entries()].map(([epc, lastSeenAt]) => ({ epc, lastSeenAt }))
    },
  }
}
