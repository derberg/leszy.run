// Minimal Drizzle-shaped stub for CrossingDetector tests.
//
// The detector's whole DB surface (grep db.query/db.select/db.insert/db.update
// in crossingDetector.js):
//   db.query.results.findFirst({ where })
//   db.select({ count }).from(gateCrossings).where()   -> [{ count }]
//   db.select({ ...fields }).from(results).where()      -> result rows
//   db.insert(t).values(v).returning()
//   db.insert(t).values(v).onConflictDoUpdate({ set })
//   db.insert(t).values(v)                             (fire-and-forget, .catch())
//   db.update(t).set(patch).where()
//
// Result rows are keyed by participantId so ON CONFLICT DO UPDATE and findFirst
// behave like the real unique(raceRunId, participantId) constraint.
export function createFakeDb({ resultsRows = [] } = {}) {
  const rows = resultsRows.map((r) => ({ ...r }))
  const inserts = { gate_crossings: [], gate_events: [], results: [] }

  const tableName = (t) => {
    const sym = Object.getOwnPropertySymbols(t ?? {}).find((s) => String(s).includes('Name'))
    return (sym && t[sym]) || 'unknown'
  }

  const upsertResult = (vals, setPatch) => {
    const existing = rows.find((r) => r.participantId === vals.participantId)
    if (existing) Object.assign(existing, setPatch ?? vals)
    else rows.push({ id: `res-${rows.length + 1}`, ...vals })
  }

  const db = {
    _rows: () => rows,
    _inserts: () => inserts,

    query: {
      results: {
        // The detector always narrows to one (raceRunId, participantId); tests run
        // a single race, so matching on participantId alone is equivalent.
        findFirst: async ({ where } = {}) => {
          const pid = extractParticipantId(where)
          return pid ? rows.find((r) => r.participantId === pid) : rows[0]
        },
      },
    },

    select(fields = {}) {
      const isCount = 'count' in fields
      return {
        from: (t) => {
          const name = tableName(t)
          const value = isCount
            ? [{ count: inserts.gate_crossings.length }]
            : name === 'results' ? rows : []
          const mk = () => {
            const p = Promise.resolve(value)
            p.orderBy = () => Promise.resolve(value)
            p.limit = () => Promise.resolve(value)
            return p
          }
          const out = mk()
          out.where = mk
          return out
        },
      }
    },

    insert(t) {
      const name = tableName(t)
      return {
        values: (vals) => {
          const list = Array.isArray(vals) ? vals : [vals]
          if (!inserts[name]) inserts[name] = []
          inserts[name].push(...list)
          if (name === 'results') list.forEach((v) => upsertResult(v))
          const made = [{ id: `${name}-${inserts[name].length}` }]
          const p = Promise.resolve(made)
          p.returning = () => Promise.resolve(made)
          p.onConflictDoUpdate = ({ set }) => {
            if (name === 'results') list.forEach((v) => upsertResult(v, set))
            return Promise.resolve(made)
          }
          p.onConflictDoNothing = () => {
            const q = Promise.resolve([])
            q.returning = () => Promise.resolve([])
            return q
          }
          return p
        },
      }
    },

    update() {
      return {
        set: (patch) => ({
          where: (pred) => {
            const pid = extractParticipantId(pred)
            const targets = pid ? rows.filter((r) => r.participantId === pid) : rows
            targets.forEach((r) => Object.assign(r, patch))
            return Promise.resolve([])
          },
        }),
      }
    },
  }

  return db
}

// Walks a Drizzle condition object for a bound participantId. Deliberately
// loose — the stub only needs to tell one participant's predicate from another's,
// and test ids are of the form p1/p2/p3.
function extractParticipantId(node, depth = 0) {
  if (!node || depth > 10) return null
  if (typeof node === 'string') return /^p\d+$/.test(node) ? node : null
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = extractParticipantId(n, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) {
      const found = extractParticipantId(v, depth + 1)
      if (found) return found
    }
  }
  return null
}

export function createFakeBroadcast() {
  const sent = []
  const fn = (event, payload) => sent.push({ event, payload })
  fn.sent = sent
  fn.crossings = () => sent.filter((s) => s.event === 'rfid:crossing').map((s) => s.payload)
  return fn
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))
