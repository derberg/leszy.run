import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Append-only JSONL queue + persisted upload cursor. One row per confirmed
// pass — volume is tiny (one per runner), so appendFile-per-row is fine and
// gives us durability at row granularity. A torn final line (power loss
// mid-append) is dropped on reload.
export class ObservationQueue {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.queuePath = join(dataDir, 'queue.jsonl')
    this.cursorPath = join(dataDir, 'cursor.json')
    this.rows = []
    this.cursor = 0
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    try {
      const text = await readFile(this.queuePath, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { this.rows.push(JSON.parse(line)) } catch { /* torn last line — drop */ }
      }
    } catch { /* no queue yet */ }
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
