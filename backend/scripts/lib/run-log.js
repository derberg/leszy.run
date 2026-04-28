import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.resolve(__dirname, '../../logs')

function tsStamp() {
  return new Date().toISOString().replace(/[:.-]/g, '').slice(0, 15)
}

export function logsDir() {
  return LOG_DIR
}

export async function loadPreviousRun(scriptName) {
  try {
    const entries = await readdir(LOG_DIR)
    const prefix = `${scriptName}-`
    const runs = entries.filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort()
    if (runs.length === 0) return { file: null, summary: null }
    const last = runs[runs.length - 1]
    const summary = JSON.parse(await readFile(path.join(LOG_DIR, last), 'utf8'))
    return { file: last, summary }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[run-log] Could not load previous run for ${scriptName}:`, err.message)
    return { file: null, summary: null }
  }
}

export function previousFailureIds(prev) {
  const ids = new Set()
  if (!prev || !prev.summary) return ids
  for (const f of prev.summary.failures || []) {
    if (f.id) ids.add(f.id)
  }
  return ids
}

export function tagPersistent(failures, prevFailureIds) {
  let persistent = 0
  for (const f of failures) {
    f.persistent = prevFailureIds.has(f.id)
    if (f.persistent) persistent++
  }
  return { persistent, fresh: failures.length - persistent }
}

export async function writeRunLog(scriptName, summary) {
  await mkdir(LOG_DIR, { recursive: true })
  const file = path.join(LOG_DIR, `${scriptName}-${tsStamp()}.json`)
  await writeFile(file, JSON.stringify(summary, null, 2))
  return file
}
