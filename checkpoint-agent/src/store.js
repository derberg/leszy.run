import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export class FileStore {
  constructor(dataDir) { this.dataDir = dataDir }
  #path(name) { return join(this.dataDir, `${name}.json`) }
  async load(name) {
    try { return JSON.parse(await readFile(this.#path(name), 'utf8')) } catch { return null }
  }
  async save(name, obj) {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.#path(name), JSON.stringify(obj, null, 2))
  }
  async remove(name) { await rm(this.#path(name), { force: true }) }
}
