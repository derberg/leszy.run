import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Append-only JSONL queue + persisted upload cursor. One row per confirmed
// pass — volume is tiny (one per runner), so appendFile-per-row is fine and
// gives us durability at row granularity. A torn final line (power loss
// mid-append) is dropped on reload.
//
// Scoped per checkpoint session: pass a `suffix` (typically the checkpointId)
// to get dedicated `queue-<suffix>.jsonl` / `cursor-<suffix>.json` files so a
// new checkpoint session starts clean instead of inheriting every EPC the
// device has ever seen. Omitting `suffix` keeps the original unscoped
// `queue.jsonl` / `cursor.json` files (existing unit tests + callers that
// don't care about scoping).
const SAFE_SUFFIX = /^[A-Za-z0-9_-]+$/

export class ObservationQueue {
  constructor(dataDir, suffix) {
    // Defense in depth: suffix flows into a filesystem path
    // (queue-<suffix>.jsonl / cursor-<suffix>.json). Even though callers are
    // expected to validate their own input (e.g. app.js validates
    // checkpointId before it ever reaches here), reject anything that isn't
    // a plain token so this class can never be turned into an arbitrary-path
    // file-append primitive.
    if (suffix !== undefined && suffix !== null && !SAFE_SUFFIX.test(suffix)) {
      throw new Error('invalid queue suffix')
    }
    this.dataDir = dataDir
    this.suffix = suffix
    this.queuePath = join(dataDir, suffix ? `queue-${suffix}.jsonl` : 'queue.jsonl')
    this.cursorPath = join(dataDir, suffix ? `cursor-${suffix}.json` : 'cursor.json')
    this.rows = []
    this.cursor = 0
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    let hadTornLine = false
    try {
      const text = await readFile(this.queuePath, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { this.rows.push(JSON.parse(line)) } catch { hadTornLine = true /* torn last line — drop */ }
      }
    } catch { /* no queue yet */ }
    // If a line failed to parse, rewrite the file with only successfully parsed rows
    if (hadTornLine) {
      const clean = this.rows.map(r => JSON.stringify(r)).join('\n') + (this.rows.length > 0 ? '\n' : '')
      await writeFile(this.queuePath, clean)
    }
    try {
      const c = JSON.parse(await readFile(this.cursorPath, 'utf8'))
      this.cursor = Math.min(c.uploaded ?? 0, this.rows.length)
    } catch { this.cursor = 0 }
  }

  async append(rowObj) {
    this.rows.push(rowObj)
    await appendFile(this.queuePath, JSON.stringify(rowObj) + '\n')
  }

  pending() { return this.rows.slice(this.cursor) }

  async advance(n) {
    this.cursor += n
    await writeFile(this.cursorPath, JSON.stringify({ uploaded: this.cursor }))
  }

  epcs() { return this.rows.map(r => r.epc) }

  get counts() { return { total: this.rows.length, pending: this.rows.length - this.cursor } }
}
